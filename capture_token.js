/**
 * Stockbit Dual Token Capture Script
 * ===================================
 * Captures BOTH Main Token and Securities Token in ONE browser session.
 * 
 * Flow:
 * Phase 1: Login -> Capture Main Token from request headers
 * Phase 2: Navigate to Trading -> Enter PIN -> Capture Securities Token from auth response
 * Phase 3: After Trading loaded, capture the exodus token used by the trading page
 * (this v2 token has `acn` field needed for order-trade endpoints)
 * 
 * Usage Options:
 *   node capture_token.js             -> Standard dual token capture
 *   node capture_token.js --discover  -> Captures tokens AND clicks around to discover new endpoints
 */

const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');
const path = require('path');

puppeteer.use(StealthPlugin());

// ==================== STATE ====================
let mainTokenCaptured = false;
let securitiesTokenCaptured = false;
let tradingSessionTokenCaptured = false;
let browser = null;
const isDiscoverMode = process.argv.includes('--discover');
const foundEndpoints = new Set();

const CREDENTIALS_PATH = path.join(__dirname, '.credentials.json');

// Initialize .credentials.json structure if missing
if (!fs.existsSync(CREDENTIALS_PATH)) {
    fs.writeFileSync(CREDENTIALS_PATH, JSON.stringify({ data: '', tokens: {} }, null, 2));
}

// ==================== TOKEN HELPERS ====================
function decodeJWT(token) {
    try {
        const payload = token.split('.')[1];
        return JSON.parse(Buffer.from(payload, 'base64url').toString());
    } catch { return null; }
}

function getCredentials() {
    try {
        const raw = fs.readFileSync(CREDENTIALS_PATH, 'utf8');
        const creds = JSON.parse(raw);
        if (!creds.tokens) creds.tokens = {};
        return creds;
    } catch {
        return { data: '', tokens: {} };
    }
}

function saveMainToken(accessToken, refreshToken) {
    if (mainTokenCaptured) return;
    mainTokenCaptured = true;
    
    const creds = getCredentials();
    creds.tokens.main = {
        accessToken,
        refreshToken: refreshToken || '',
        savedAt: new Date().toISOString()
    };
    fs.writeFileSync(CREDENTIALS_PATH, JSON.stringify(creds, null, 2));
    
    const payload = decodeJWT(accessToken);
    console.log('\n✅ MAIN TOKEN DISIMPAN!');
    console.log('   Version:', payload?.ver || 'unknown');
    console.log('   User:', payload?.data?.use || 'unknown');
    console.log('   Has ACN:', payload?.data?.acn ? 'YES (' + payload.data.acn + ')' : 'NO');
}

function saveSecuritiesToken(accessToken, refreshToken) {
    if (securitiesTokenCaptured) return;
    securitiesTokenCaptured = true;
    
    const creds = getCredentials();
    creds.tokens.securities = {
        accessToken: accessToken,
        refreshToken: refreshToken || '',
        savedAt: new Date().toISOString()
    };
    fs.writeFileSync(CREDENTIALS_PATH, JSON.stringify(creds, null, 2));
    
    const payload = decodeJWT(accessToken);
    console.log('✅ SECURITIES TOKEN DISIMPAN!');
    console.log('   ACN:', payload?.data?.acn || 'unknown');
    console.log('   Account Type:', payload?.data?.act || 'unknown');
}

/**
 * Upgrade the main token to a v2 token that has `acn` field.
 * This happens when the Trading page makes requests to exodus with the trading-aware token.
 */
function upgradeMainToken(accessToken) {
    if (tradingSessionTokenCaptured) return;
    const payload = decodeJWT(accessToken);
    if (!payload?.data?.acn) return; // Only upgrade if it has trading context

    tradingSessionTokenCaptured = true;

    const creds = getCredentials();
    const existingRefresh = creds.tokens.main?.refreshToken || '';

    creds.tokens.main = {
        accessToken,
        refreshToken: existingRefresh,
        savedAt: new Date().toISOString()
    };
    fs.writeFileSync(CREDENTIALS_PATH, JSON.stringify(creds, null, 2));
    console.log('⬆️  MAIN TOKEN UPGRADED ke v2 (with ACN)!');
    console.log('   ACN:', payload.data.acn);
}

// ==================== MAIN FLOW ====================
(async () => {
    console.log('╔═══════════════════════════════════════════╗');
    console.log('║  STOCKBIT DUAL TOKEN CAPTURE              ║');
    console.log('║  Phase 1: Login & Main Token              ║');
    console.log('║  Phase 2: Trading PIN & Securities Token  ║');
    console.log('╚═══════════════════════════════════════════╝\n');

    try {
        browser = await puppeteer.launch({
            headless: false,
            defaultViewport: null,
            args: ['--start-maximized']
        });

        const page = await browser.newPage();

        // ===== INTERCEPTOR: Capture tokens from ALL responses =====
        page.on('response', async (response) => {
            const url = response.url();
            try {
                // Capture Securities Token from Carina auth endpoint
                if (url.includes('carina.stockbit.com/auth/v2/login') && response.status() === 200) {
                    const text = await response.text();
                    try {
                        const json = JSON.parse(text);
                        if (json.data && json.data.access_token) {
                            console.log('\n⭐ [PHASE 2] Securities Token ditangkap dari Carina auth!');
                            saveSecuritiesToken(json.data.access_token, json.data.refresh_token);
                            checkAllDone();
                        }
                    } catch { }
                }

                // Capture Main Token from login response
                if (!mainTokenCaptured && (url.includes('/login') || url.includes('/auth')) && response.status() === 200) {
                    const text = await response.text();
                    try {
                        const json = JSON.parse(text);
                        const token = findToken(json);
                        if (token) {
                            console.log('[PHASE 1] Main Token ditangkap dari login response!');
                            saveMainToken(token.access, token.refresh);
                        }
                    } catch { }
                }
            } catch { }
        });

        // ===== INTERCEPTOR: Capture Bearer tokens from request headers =====
        page.on('request', (request) => {
            const headers = request.headers();
            const auth = headers['authorization'] || '';
            if (!auth.startsWith('Bearer ') || auth.length < 200) return;

            const token = auth.split('Bearer ')[1];
            const url = request.url();

            // Phase 1: Capture main token from first exodus request
            if (!mainTokenCaptured && url.includes('exodus.stockbit.com')) {
                console.log('[PHASE 1] Main Token ditangkap dari request ke exodus!');
                saveMainToken(token, '');
            }

            // Phase 3: After trading login, upgrade main token if exodus gets a v2 token with ACN
            if (mainTokenCaptured && securitiesTokenCaptured && !tradingSessionTokenCaptured) {
                if (url.includes('exodus.stockbit.com')) {
                    upgradeMainToken(token);
                }
            }

            // ===== DISCOVERY MODE LOGIC =====
            if (isDiscoverMode && (url.includes('exodus.stockbit.com') || url.includes('carina.stockbit.com'))) {
                const basePath = url.split('?')[0];
                if (!foundEndpoints.has(basePath) && !basePath.includes('/stream/') && !basePath.includes('/user/')) {
                    foundEndpoints.add(basePath);
                    fs.appendFileSync('discovered_endpoints.txt', `${request.method()} ${basePath}\n`);
                    console.log(`[DISCOVERY] ${request.method()} ${basePath}`);
                }
            }
        });

        // ===== Phase 1: Navigate to login =====
        console.log('📍 Phase 1: Membuka halaman login...');
        await page.goto('https://stockbit.com/login', { waitUntil: 'networkidle2', timeout: 30000 });

        // Auto-fill credentials
        try {
            const creds = getCredentials();
            let email = '';
            let pass = '';
            if (creds.data) {
                const decoded = JSON.parse(Buffer.from(creds.data, 'base64').toString('utf8'));
                email = decoded.username || '';
                pass = decoded.password || '';
            }

            if (!email || !pass) {
                console.log('   ⚠️ Data login tidak ditemukan di .credentials.json. Silakan login manual.');
            } else {
                await page.waitForSelector('input[id="username"], input[name="username"], input[type="text"]', { timeout: 10000 });
                const usernameInput = await page.$('input[id="username"]') || await page.$('input[name="username"]') || await page.$('input[type="text"]');
                if (usernameInput) {
                    await usernameInput.click({ clickCount: 3 });
                    await usernameInput.type(email, { delay: 30 });
                    console.log('   ✓ Email diketik otomatis');
                }

                await page.waitForSelector('input[type="password"]', { timeout: 5000 });
                const passwordInput = await page.$('input[id="password"]') || await page.$('input[type="password"]');
                if (passwordInput) {
                    await passwordInput.click({ clickCount: 3 });
                    await passwordInput.type(pass, { delay: 30 });
                    console.log('   ✓ Password diketik otomatis');
                }
            }
        } catch (e) {
            console.log('   ⚠️ Auto-fill gagal:', e.message);
        }

        console.log('\n┌─────────────────────────────────────────┐');
        console.log('│  MENUNGGU ANDA UNTUK:                   │');
        console.log('│  1. Centang Captcha (jika ada)           │');
        console.log('│  2. Klik tombol LOGIN                    │');
        console.log('│  3. Approve notifikasi di HP             │');
        console.log('└─────────────────────────────────────────┘\n');

        // ===== Phase 1 → Phase 2: Wait for main token, then proceed =====
        // Poll for main token capture
        await new Promise((resolve) => {
            const checkInterval = setInterval(async () => {
                if (mainTokenCaptured) {
                    clearInterval(checkInterval);
                    resolve();
                    return;
                }
                // Also try localStorage as fallback
                try {
                    const stored = await page.evaluate(() => {
                        for (let i = 0; i < localStorage.length; i++) {
                            const key = localStorage.key(i);
                            const val = localStorage.getItem(key);
                            if (val && val.length > 100 && (key.toLowerCase().includes('token') || key.toLowerCase().includes('auth'))) {
                                return val;
                            }
                        }
                        return null;
                    });
                    if (stored && !mainTokenCaptured) {
                        console.log('[PHASE 1] Main Token ditemukan di localStorage!');
                        saveMainToken(stored, '');
                        clearInterval(checkInterval);
                        resolve();
                    }
                } catch { }
            }, 2000);

            // Safety timeout after 5 minutes
            setTimeout(() => { clearInterval(checkInterval); resolve(); }, 300000);
        });

        if (!mainTokenCaptured) {
            console.log('\n❌ Timeout: Main Token tidak tertangkap dalam 5 menit.');
            await browser.close();
            return;
        }

        // ===== Phase 2: Navigate to Trading =====
        console.log('\n📍 Phase 2: Navigasi ke halaman Trading...');
        await new Promise(r => setTimeout(r, 2000)); // Let the page settle

        await page.goto('https://stockbit.com/trading', { waitUntil: 'networkidle2', timeout: 30000 });
        console.log('   ✓ Halaman Trading dimuat');

        // Try to find and fill PIN input
        await attemptPINEntry(page);

        // Wait for securities token or timeout
        console.log('\n⏳ Menunggu Securities Token ditangkap...');
        await new Promise((resolve) => {
            const checkInterval = setInterval(() => {
                if (securitiesTokenCaptured) {
                    clearInterval(checkInterval);
                    resolve();
                }
            }, 1000);
            setTimeout(() => { clearInterval(checkInterval); resolve(); }, 60000);
        });

        if (securitiesTokenCaptured) {
            // Phase 3: Wait a moment to capture the upgraded exodus token
            console.log('\n📍 Phase 3: Menunggu token v2 untuk exodus...');
            await new Promise(r => setTimeout(r, 5000));

            // Trigger a request to exodus to capture the trading-aware token
            try {
                await page.goto('https://stockbit.com/watchlist', { waitUntil: 'networkidle2', timeout: 15000 });
                await new Promise(r => setTimeout(r, 3000));
            } catch { }
        } else {
            console.log('\n⚠️ Securities Token TIDAK tertangkap secara otomatis.');
            console.log('   Jika PIN sudah dimasukkan tapi token tidak ditangkap,');
            console.log('   coba klik menu Trading lain (Portfolio/Orderbook).');
            console.log('   Script masih menunggu 60 detik...');
            await new Promise(r => setTimeout(r, 60000));
        }

        // ===== DISCOVERY MODE NAVIGATION =====
        if (isDiscoverMode) {
            console.log('\n📍 [DISCOVERY MODE] Navigasi ke halaman tambahan untuk capture endpoint...');
            try {
                await page.goto('https://stockbit.com/symbol/BBCA/financials', { waitUntil: 'networkidle2', timeout: 15000 });
                await new Promise(r => setTimeout(r, 3000));
                await page.goto('https://stockbit.com/symbol/BBCA/keystats', { waitUntil: 'networkidle2', timeout: 15000 });
                await new Promise(r => setTimeout(r, 3000));
                await page.goto('https://stockbit.com/chartboard', { waitUntil: 'networkidle2', timeout: 15000 });
                await new Promise(r => setTimeout(r, 5000));
            } catch (e) { console.log('Timeout saat discovery navigasi', e.message); }
        }

        // ===== Done =====
        checkAllDone();

        // Final wait before close
        if (!securitiesTokenCaptured) {
            console.log('\n⚠️ Hanya Main Token yang berhasil ditangkap.');
            console.log('   Securities Token gagal. Anda bisa set manual via /auth/securities/set-token');
        }

        console.log('\n🔒 Browser akan ditutup dalam 3 detik...');
        await new Promise(r => setTimeout(r, 3000));
        await browser.close();

    } catch (err) {
        console.error('❌ Error:', err.message);
        if (browser) await browser.close();
    }
})();

// ==================== PIN ENTRY LOGIC ====================
async function attemptPINEntry(page) {
    console.log('🔎 Mencari form PIN Trading...');

    // Strategy 1: Look for any visible input field (password, tel, text with maxlength=1, etc.)
    const selectors = [
        'input[type="password"]',
        'input[type="tel"]',
        'input[inputmode="numeric"]',
        'input[maxlength="1"]',
        'input[data-cy*="pin"]',
        'input[placeholder*="PIN"]',
    ];

    for (const sel of selectors) {
        try {
            await page.waitForSelector(sel, { timeout: 5000, visible: true });
            console.log(`   ✓ PIN input ditemukan: ${sel}`);
            await new Promise(r => setTimeout(r, 1000));

            const inputs = await page.$$(sel);
            if (inputs.length >= 6) {
                // 6 separate input boxes (common PIN pad pattern)
                console.log(`   Mengisi ${inputs.length} kolom PIN...`);
                for (let i = 0; i < 6; i++) {
                    await inputs[i].click();
                    await inputs[i].type('060696'.charAt(i), { delay: 80 });
                }
                console.log('   ✓ PIN dimasukkan!');
                return;
            } else if (inputs.length >= 1) {
                // Single input field
                console.log('   Mengisi 1 kolom PIN...');
                await inputs[0].click();
                await inputs[0].type('060696', { delay: 80 });
                console.log('   ✓ PIN dimasukkan!');

                // Try to find and click submit button
                const submitBtn = await page.$('button[type="submit"]') || await page.$('button.ant-btn-primary');
                if (submitBtn) {
                    await submitBtn.click();
                    console.log('   ✓ Tombol submit diklik');
                }
                return;
            }
        } catch { /* selector not found, try next */ }
    }

    // Strategy 2: Use keyboard to type PIN directly (some UIs capture keyboard events globally)
    console.log('   ⚠️ Tidak menemukan input field spesifik untuk PIN.');
    console.log('   Mencoba ketik PIN via keyboard...');
    try {
        await page.keyboard.type('060696', { delay: 150 });
        console.log('   ✓ PIN diketik via keyboard!');
        await new Promise(r => setTimeout(r, 1000));
        await page.keyboard.press('Enter');
    } catch {
        console.log('   ⚠️ Keyboard input juga gagal. Silakan ketik PIN secara manual di browser.');
    }
}

// ==================== COMPLETION CHECK ====================
function checkAllDone() {
    if (mainTokenCaptured && securitiesTokenCaptured) {
        console.log('\n╔═══════════════════════════════════════════╗');
        console.log('║  🎉 SEMUA TOKEN BERHASIL DITANGKAP!       ║');
        console.log('║                                           ║');
        console.log('║  Semua disatukan dalam: .credentials.json ║');
        if (tradingSessionTokenCaptured) {
            console.log('║  ⬆️  Main upgraded → v2 with ACN           ║');
        }
        console.log('║                                           ║');
        console.log('║  Jalankan: npm start                      ║');
        console.log('╚═══════════════════════════════════════════╝');
    }
}

// ==================== TOKEN FINDER ====================
function findToken(obj, depth = 0) {
    if (depth > 5 || !obj || typeof obj !== 'object') return null;

    if (obj.access_token || obj.accessToken || (obj.token_data && obj.token_data.access)) {
        return {
            access: obj.access_token || obj.accessToken || obj.token_data?.access?.token || '',
            refresh: obj.refresh_token || obj.refreshToken || obj.token_data?.refresh?.token || ''
        };
    }

    if (obj.data?.login?.token_data?.access?.token) {
        return {
            access: obj.data.login.token_data.access.token,
            refresh: obj.data.login.token_data.refresh?.token || ''
        };
    }

    for (const key of Object.keys(obj)) {
        const result = findToken(obj[key], depth + 1);
        if (result) return result;
    }
    return null;
}
