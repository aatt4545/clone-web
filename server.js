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
// リソース取得（完全版）
// ============================================
async function fetchResource(url, baseUrl, headers = {}) {
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
                'Referer': baseUrl,
                ...headers
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

function getExtension(url, contentType) {
    const urlExt = path.extname(new URL(url, 'http://example.com').pathname).slice(1).toLowerCase();
    
    if (urlExt && urlExt.length <= 5) return urlExt;
    
    if (contentType) {
        return mime.extension(contentType) || 'bin';
    }
    
    return 'bin';
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

// ============================================
// CSS内のリソース抽出
// ============================================
async function extractCSSResources(cssCode, cssUrl, baseUrl, config, resources, resourceMap, resourceCount, maxResources) {
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
            
            // CSS内のパスを置換
            updatedCSS = updatedCSS.replace(assetUrl, filename);
            
            resourceCount++;
        }
    }
    
    return { updatedCSS, resourceCount };
}

// ============================================
// HTML内のリソース抽出
// ============================================
async function extractHTMLResources($, html, url, config, resources, resourceMap, resourceCount, maxResources) {
    let updatedHTML = html;
    
    // CSS (link)
    if (!config.clone || config.clone.css !== false) {
        const cssLinks = [];
        $('link[rel="stylesheet"]').each((i, el) => {
            const href = $(el).attr('href');
            if (href && !href.startsWith('data:') && resourceCount < maxResources) {
                cssLinks.push(href);
            }
        });
        
        for (const cssUrl of cssLinks) {
            if (resourceCount >= maxResources) break;
            
            const fullCssUrl = resolveURL(cssUrl, url);
            if (!fullCssUrl) continue;
            
            const content = await fetchResource(fullCssUrl, url);
            if (content && content.data) {
                let cssCode = content.data.toString('utf8');
                
                // CSS内のリソースも抽出
                const result = await extractCSSResources(cssCode, fullCssUrl, url, config, resources, resourceMap, resourceCount, maxResources);
                cssCode = result.updatedCSS;
                resourceCount = result.resourceCount;
                
                if (config.output && config.output.minify) {
                    cssCode = minifyCSS(cssCode);
                }
                
                const filename = config.output && config.output.randomizeNames ? randomName('css') : path.basename(new URL(fullCssUrl).pathname) || randomName('css');
                resources[filename] = cssCode;
                resourceMap[cssUrl] = filename;
                resourceMap[fullCssUrl] = filename;
                resourceCount++;
            }
        }
    }
    
    // JavaScript
    if (!config.clone || config.clone.js !== false) {
        const jsFiles = [];
        $('script[src]').each((i, el) => {
            const src = $(el).attr('src');
            if (src && !src.startsWith('data:') && resourceCount < maxResources) {
                jsFiles.push(src);
            }
        });
        
        for (const jsUrl of jsFiles) {
            if (resourceCount >= maxResources) break;
            
            const fullJsUrl = resolveURL(jsUrl, url);
            if (!fullJsUrl) continue;
            
            const content = await fetchResource(fullJsUrl, url);
            if (content && content.data) {
                let jsCode = content.data.toString('utf8');
                
                if (config.output && config.output.obfuscate) {
                    jsCode = obfuscateJS(jsCode);
                } else if (config.output && config.output.minify) {
                    jsCode = minifyJS(jsCode);
                }
                
                const filename = config.output && config.output.randomizeNames ? randomName('js') : path.basename(new URL(fullJsUrl).pathname) || randomName('js');
                resources[filename] = jsCode;
                resourceMap[jsUrl] = filename;
                resourceMap[fullJsUrl] = filename;
                resourceCount++;
            }
        }
    }
    
    // 画像
    if (!config.clone || config.clone.images !== false) {
        const images = [];
        $('img').each((i, el) => {
            const src = $(el).attr('src');
            if (src && !src.startsWith('data:') && resourceCount < maxResources) {
                images.push(src);
            }
        });
        
        // srcset 属性も処理
        $('img[srcset]').each((i, el) => {
            const srcset = $(el).attr('srcset');
            const srcsetUrls = srcset.split(',').map(s => s.trim().split(' ')[0]);
            srcsetUrls.forEach(src => {
                if (src && !src.startsWith('data:') && resourceCount < maxResources) {
                    images.push(src);
                }
            });
        });
        
        // 背景画像
        $('[style*="background"]').each((i, el) => {
            const style = $(el).attr('style');
            const bgRegex = /background(?:-image)?\s*:\s*url\(['"]?([^'")]+)['"]?\)/g;
            let match;
            while ((match = bgRegex.exec(style)) !== null) {
                if (match[1] && !match[1].startsWith('data:') && resourceCount < maxResources) {
                    images.push(match[1]);
                }
            }
        });
        
        // ファビコン
        $('link[rel="icon"], link[rel="shortcut icon"], link[rel="apple-touch-icon"]').each((i, el) => {
            const href = $(el).attr('href');
            if (href && !href.startsWith('data:') && resourceCount < maxResources) {
                images.push(href);
            }
        });
        
        for (const imgUrl of images) {
            if (resourceCount >= maxResources) break;
            
            const fullImgUrl = resolveURL(imgUrl, url);
            if (!fullImgUrl) continue;
            
            const content = await fetchResource(fullImgUrl, url);
            if (content && content.data) {
                const ext = getExtension(fullImgUrl, content.contentType);
                const filename = config.output && config.output.randomizeNames ? randomName(ext) : path.basename(new URL(fullImgUrl).pathname) || randomName(ext);
                
                resources[filename] = content.data;
                resourceMap[imgUrl] = filename;
                resourceMap[fullImgUrl] = filename;
                resourceCount++;
            }
        }
    }
    
    // フォント
    if (!config.clone || config.clone.fonts !== false) {
        const fonts = [];
        $('link[rel="preload"][as="font"], link[rel="preload"][type="font/woff2"]').each((i, el) => {
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
            if (src && !src.startsWith('data:') && resourceCount < maxResources) {
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
    for (const [originalUrl, newFilename] of Object.entries(resourceMap)) {
        const escapedUrl = originalUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        updatedHTML = updatedHTML.split(escapedUrl).join(newFilename);
    }
    
    return { updatedHTML, resourceCount };
}

// ============================================
// メインクローン関数
// ============================================
async function cloneSiteDeep(url, config) {
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
    const $ = cheerio.load(html);
    const resources = {};
    const resourceMap = {};
    let resourceCount = 0;
    
    const maxResources = (config.clone && config.clone.maxResources) || 500;
    
    const result = await extractHTMLResources($, html, url, config, resources, resourceMap, resourceCount, maxResources);
    html = result.updatedHTML;
    
    // フィッシング自動化
    if (config.phishing && config.phishing.enabled) {
        // ... 既存のフィッシングコード ...
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
    
    resources['index.html'] = html;
    
    return resources;
}

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
            archive.append(content, { name: `${siteName}/${filename}` });
        });
        
        archive.finalize();
        
        console.log(`Cloned: ${config.url} | Resources: ${Object.keys(resources).length} | Size: ${JSON.stringify(resources).length} bytes`);
    } catch(e) {
        console.error(e);
        res.status(500).json({ error: e.message });
    }
});

// ============================================
// キャプチャエンドポイント
// ============================================
app.post('/capture', (req, res) => {
    const data = req.body;
    const log = `[${new Date().toISOString()}] ${JSON.stringify(data)}\n`;
    fs.appendFileSync('captured.log', log);
    res.json({ success: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Clone server running on ${PORT}`);
});
