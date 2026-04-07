#!/usr/bin/env node
'use strict';

const fs = require('fs');

async function main() {
  const targetUrl = process.argv[2];
  if (!targetUrl) {
    throw new Error('URL manquante');
  }

  let puppeteer;
  try {
    puppeteer = require('puppeteer');
  } catch (err) {
    throw new Error('Puppeteer non installe. Lance `npm install puppeteer` sur le projet.');
  }

  const launchArgs = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-blink-features=AutomationControlled',
    '--autoplay-policy=no-user-gesture-required',
  ];

  const launchOptions = {
    headless: true,
    args: launchArgs,
  };

  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    launchOptions.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
  }

  const browser = await puppeteer.launch(launchOptions);
  const page = await browser.newPage();

  const networkStreams = [];
  const seen = new Set();

  page.on('requestfinished', async request => {
    try {
      const url = request.url();
      if (!/googlevideo\.com|youtube\.com\/api\/manifest/i.test(url)) return;
      if (!/videoplayback|manifest|m3u8|mpd/i.test(url)) return;
      if (seen.has(url)) return;
      seen.add(url);

      const parsed = new URL(url);
      const mime = parsed.searchParams.get('mime') || '';
      const itag = parsed.searchParams.get('itag') || '';
      const clen = parsed.searchParams.get('clen') || '0';
      const bitrate = parsed.searchParams.get('bitrate') || parsed.searchParams.get('initcwndbps') || '';
      const quality = parsed.searchParams.get('quality_label') || parsed.searchParams.get('quality') || '';
      networkStreams.push({
        id: itag || `net-${networkStreams.length + 1}`,
        url,
        ext: url.includes('.m3u8') ? 'm3u8' : (url.includes('.mpd') ? 'mpd' : 'mp4'),
        resolution: quality || 'auto',
        mime,
        filesize: Number(clen) || 0,
        tbr: bitrate ? Math.round(Number(bitrate) / 1000) : null,
        has_audio: /audio/.test(mime) || !mime,
        has_video: /video/.test(mime) || !mime,
      });
    } catch (_) {}
  });

  await page.setViewport({ width: 1366, height: 900 });
  await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForTimeout(5000);

  try {
    const consentBtn = await page.$('button[aria-label*="Accept"], button[aria-label*="Tout accepter"], button[aria-label*="I agree"]');
    if (consentBtn) {
      await consentBtn.click().catch(() => {});
      await page.waitForTimeout(1500);
    }
  } catch (_) {}

  try {
    await page.evaluate(() => {
      const video = document.querySelector('video');
      if (video) {
        video.muted = true;
        const p = video.play();
        if (p && typeof p.catch === 'function') p.catch(() => {});
      }
    });
  } catch (_) {}

  await page.waitForTimeout(4000);

  const data = await page.evaluate(() => {
    const pr = window.ytInitialPlayerResponse || null;
    const ytcfg = window.ytcfg?.data_ || window.ytcfg?.data || null;
    const vd =
      ytcfg?.INNERTUBE_CONTEXT?.client?.visitorData ||
      ytcfg?.VISITOR_DATA ||
      null;
    return {
      title: pr?.videoDetails?.title || document.title || '',
      thumbnail: pr?.videoDetails?.thumbnail?.thumbnails?.slice(-1)?.[0]?.url || '',
      duration: Number(pr?.videoDetails?.lengthSeconds || 0) || null,
      visitor_data: vd,
      formats: [
        ...(pr?.streamingData?.formats || []),
        ...(pr?.streamingData?.adaptiveFormats || []),
      ].map((f, idx) => ({
        id: f.itag ? String(f.itag) : `fmt-${idx + 1}`,
        url: f.url || '',
        ext: f.mimeType?.includes('webm') ? 'webm' : 'mp4',
        resolution: f.qualityLabel || f.quality || 'auto',
        mime: f.mimeType || '',
        filesize: Number(f.contentLength || 0) || 0,
        tbr: f.bitrate ? Math.round(Number(f.bitrate) / 1000) : null,
        fps: f.fps || null,
        has_audio: !/video\/.*codecs="[^"]*"$/.test(f.mimeType || '') || /audio\//.test(f.mimeType || ''),
        has_video: /video\//.test(f.mimeType || ''),
        vcodec: f.mimeType || '',
        acodec: f.mimeType || '',
      })).filter(f => f.url),
      userAgent: navigator.userAgent,
    };
  });

  const cookies = await page.cookies('https://www.youtube.com');
  const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');

  await browser.close();

  const allStreams = [...data.formats, ...networkStreams]
    .filter(item => item && item.url)
    .filter((item, index, arr) => arr.findIndex(x => x.url === item.url) === index)
    .sort((a, b) => {
      const ar = parseInt(String(a.resolution || '0').replace(/\D+/g, ''), 10) || 0;
      const br = parseInt(String(b.resolution || '0').replace(/\D+/g, ''), 10) || 0;
      return br - ar;
    });

  if (!allStreams.length) {
    throw new Error('Aucun flux YouTube récupéré via Puppeteer');
  }

  const headers = {
    'User-Agent': data.userAgent || 'Mozilla/5.0',
    'Referer': 'https://www.youtube.com/',
    'Origin': 'https://www.youtube.com',
  };
  if (cookieHeader) headers.Cookie = cookieHeader;

  const payload = {
    ok: true,
    source: 'puppeteer',
    title: data.title,
    thumbnail: data.thumbnail,
    duration: data.duration,
    visitor_data: data.visitor_data,
    headers,
    stream_url: allStreams[0].url,
    streams: allStreams,
  };

  process.stdout.write(JSON.stringify(payload) + '\n');
}

main().catch(err => {
  const payload = {
    ok: false,
    error: err && err.message ? err.message : String(err),
  };
  process.stdout.write(JSON.stringify(payload) + '\n');
  process.exit(1);
});
