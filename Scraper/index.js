
const puppeteer = require('puppeteer');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');
const { once } = require('events');

const BASE_URL = 'https://shoob.gg';
const OUTPUT_FILE = path.join(__dirname, 'Shoob-Cards.json');

const CONCURRENCY = 5;
const PAGES_PER_SESSION = 10;
const PAGE_TIMEOUT = 35000;
const SELECTOR_TIMEOUT = 12000;
const MAX_RETRIES = 3;
const RETRY_DELAY = 500;

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function absoluteUrl(url) {
    if (!url) return null;
    try {
        return new URL(url, BASE_URL).href;
    } catch {
        return url;
    }
}

async function writeStream(stream, data) {
    if (!stream.write(data)) await once(stream, 'drain');
}

async function optimizePage(page) {
    page.setDefaultNavigationTimeout(PAGE_TIMEOUT);
    page.setDefaultTimeout(SELECTOR_TIMEOUT);
    await page.setViewport({ width: 800, height: 600, deviceScaleFactor: 1 });
    await page.setCacheEnabled(true);
    await page.setRequestInterception(true);

    page.on('request', request => {
        const type = request.resourceType();
        if (['image', 'media', 'font'].includes(type)) {
            request.abort().catch(() => {});
            return;
        }
        request.continue().catch(() => {});
    });
}

async function launchBrowser() {
    return puppeteer.launch({
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-background-networking',
            '--disable-extensions',
            '--disable-sync',
            '--disable-default-apps'
        ]
    });
}

function extractCardData(html, cardDetailUrl) {
    const $ = cheerio.load(html);
    const cardData = {};

    $('.external-shop, .card-pricing, .card-meta').remove();

    const pathname = new URL(cardDetailUrl).pathname;
    cardData.cardId = pathname.split('/').filter(Boolean).pop() || '';

    const rawTitle = $('.page-header__title').first().text().trim();
    const splitIdx = rawTitle.lastIndexOf(' - ');

    if (splitIdx !== -1) {
        cardData.cardName = rawTitle.substring(0, splitIdx).trim();
        cardData.tier = rawTitle.substring(splitIdx + 3).trim();
    } else {
        cardData.cardName = rawTitle;
        cardData.tier = 'Unknown';
    }

    let seriesName = $('.page-breadcrumb li').eq(2).text().trim();
    if (!seriesName) seriesName = $('.fff').first().text().trim();

    cardData.series = seriesName;
    cardData.sourceUrl = cardDetailUrl;

    const mainCardNode = $('.cardData').first();
    const image = mainCardNode.find('img').first();
    const video = mainCardNode.find('video').first();
    const source = video.find('source').first();

    const mediaSrc =
        image.attr('data-src') ||
        image.attr('data-original') ||
        image.attr('data-lazy-src') ||
        image.attr('src') ||
        source.attr('src') ||
        video.attr('src') ||
        video.attr('poster');

    if (mediaSrc && !mediaSrc.includes('card_back.png')) {
        cardData.mediaLink = absoluteUrl(mediaSrc);
    }

    const makers = [];

    $('h1.nice').filter((i, el) =>
        $(el).text().trim().includes('Creators')
    ).first().parent().find('p').each((i, el) => {
        const name = $(el).text().replace('Card Maker:', '').trim();
        if (name) makers.push(name);
    });

    cardData.creators = makers;

    const attributes = [];

    $('h1.nice').filter((i, el) =>
        $(el).text().trim().includes('Special attributes')
    ).first().next('div').children().each((i, el) => {
        const value = $(el).text().trim();
        if (value) attributes.push(value);
    });

    cardData.specialAttributes = attributes;

    const wantHeading = $('h1.nice').filter((i, el) =>
        $(el).text().trim().includes('People who want this card')
    ).first();

    if (wantHeading.length) {
        const match = wantHeading.text().trim().match(/^(\d+)/);
        cardData.totalPeopleWhoWant = match ? Number(match[1]) : 0;
    } else {
        cardData.totalPeopleWhoWant = 0;
    }

    const ownersList = [];

    const ownerHeading = $('h1.nice').filter((i, el) =>
        $(el).text().trim().includes('People who own this card')
    ).first();

    const ownerContainer = ownerHeading.next('div');

    ownerContainer.find('a[href^="/user/"]').each((i, el) => {
        const img = $(el).find('img').first();
        const username = img.attr('title') || img.attr('alt');
        const issueText = $(el).find('.blurple2').text().trim();
        const issueNumber = issueText.replace(/\D/g, '');

        if (username) {
            ownersList.push({
                username,
                issueNumber: issueNumber ? Number(issueNumber) : null
            });
        }
    });

    cardData.owners = ownersList;
    cardData.totalOwnersCount = ownersList.length;

    return cardData;
}

async function scrapeDetail(page, url) {
    let lastError = null;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
            await page.goto(url, {
                waitUntil: 'domcontentloaded',
                timeout: PAGE_TIMEOUT
            });

            await page.waitForSelector('.cardData', {
                timeout: SELECTOR_TIMEOUT
            });

            return extractCardData(await page.content(), url);
        } catch (error) {
            lastError = error;

            if (attempt < MAX_RETRIES) {
                console.log(`[RETRY ${attempt + 1}/${MAX_RETRIES}] ${url}`);
                await delay(RETRY_DELAY);
            }
        }
    }

    try {
        const html = await page.content();

        if (html && html.length > 100) {
            const partialData = extractCardData(html, url);
            partialData.extractionWarning = lastError.message;
            return partialData;
        }
    } catch {}

    console.error(`[FAILED] ${url}: ${lastError.message}`);

    return {
        cardId: new URL(url).pathname.split('/').filter(Boolean).pop() || '',
        sourceUrl: url,
        error: lastError.message,
        extractionFailed: true
    };
}

async function scrapeShoobCards() {
    let output;
    let pageNum = 1;
    let totalCardsExtracted = 0;
    let failedCards = 0;
    let isFirstCard = true;
    let finished = false;

    console.log('\n======================================');
    console.log('Shoob.gg Optimized Scraper');
    console.log('======================================');
    console.log(`Concurrency: ${CONCURRENCY}`);
    console.log(`Browser Recycling: Every ${PAGES_PER_SESSION} Pages`);
    console.log('Duplicate filtering: DISABLED');
    console.log('Incomplete card filtering: DISABLED');
    console.log('Media downloads: DISABLED');
    console.log('======================================\n');

    try {
        output = fs.createWriteStream(OUTPUT_FILE, { encoding: 'utf8' });
        await once(output, 'open');
        await writeStream(output, '[\n');

        while (!finished) {
            let browser;
            let sessionPagesCompleted = 0;

            try {
                console.log('\n======================================');
                console.log(`STARTING NEW BROWSER SESSION`);
                console.log(`Starting Page: ${pageNum}`);
                console.log(`Maximum Pages: ${PAGES_PER_SESSION}`);
                console.log('======================================\n');

                browser = await launchBrowser();

                const listPage = await browser.newPage();
                await optimizePage(listPage);

                const workers = [];

                for (let i = 0; i < CONCURRENCY; i++) {
                    const page = await browser.newPage();
                    await optimizePage(page);
                    workers.push(page);
                }

                while (
                    sessionPagesCompleted < PAGES_PER_SESSION &&
                    !finished
                ) {
                    const pageUrl = `${BASE_URL}/cards?page=${pageNum}`;
                    console.log(`\n[PAGE ${pageNum}] ${pageUrl}`);

                    let cardLinks = [];

                    try {
                        await listPage.goto(pageUrl, {
                            waitUntil: 'domcontentloaded',
                            timeout: PAGE_TIMEOUT
                        });

                        await listPage.waitForSelector(
                            'a[href*="/cards/info/"]',
                            { timeout: SELECTOR_TIMEOUT }
                        );

                        const $ = cheerio.load(await listPage.content());

                        $('a[href*="/cards/info/"]').each((i, el) => {
                            const href = $(el).attr('href');
                            if (href) {
                                const url = absoluteUrl(href);
                                if (url) cardLinks.push(url);
                            }
                        });
                    } catch (error) {
                        console.error(`[PAGE ERROR] ${error.message}`);
                        finished = true;
                        break;
                    }

                    if (!cardLinks.length) {
                        console.log('No more card links found.');
                        finished = true;
                        break;
                    }

                    console.log(`Found ${cardLinks.length} card links.`);

                    let nextIndex = 0;

                    const workerTasks = workers.map(async (page, workerId) => {
                        while (true) {
                            const currentIndex = nextIndex++;
                            if (currentIndex >= cardLinks.length) break;

                            const url = cardLinks[currentIndex];

                            try {
                                const card = await scrapeDetail(page, url);

                                if (card.extractionFailed) failedCards++;

                                const json = JSON.stringify(card, null, 2);

                                await writeStream(
                                    output,
                                    (isFirstCard ? '' : ',\n') + json
                                );

                                isFirstCard = false;
                                totalCardsExtracted++;

                                console.log(
                                    `[WORKER ${workerId + 1}] Saved: ${totalCardsExtracted} | ${card.cardName || url}`
                                );
                            } catch (error) {
                                failedCards++;
                                console.error(
                                    `[WORKER ${workerId + 1} ERROR] ${url}: ${error.message}`
                                );
                            }
                        }
                    });

                    await Promise.all(workerTasks);

                    console.log(`\n[PAGE ${pageNum}] Completed`);
                    console.log(`Saved: ${totalCardsExtracted}`);
                    console.log(`Failed: ${failedCards}`);

                    pageNum++;
                    sessionPagesCompleted++;
                }
            } finally {
                if (browser) {
                    console.log('\n======================================');
                    console.log('CLOSING BROWSER SESSION');
                    console.log(`Pages Completed: ${sessionPagesCompleted}`);
                    console.log(`Next Page: ${pageNum}`);
                    console.log('======================================');

                    await browser.close().catch(error => {
                        console.error('Browser close error:', error.message);
                    });

                    browser = null;
                }
            }

            if (!finished && sessionPagesCompleted === PAGES_PER_SESSION) {
                console.log('\n======================================');
                console.log('BROWSER RECYCLED SUCCESSFULLY');
                console.log(`Completed Through Page: ${pageNum - 1}`);
                console.log(`Resuming From Page: ${pageNum}`);
                console.log('Launching Fresh Chromium...');
                console.log('======================================\n');
            }
        }
    } catch (error) {
        console.error('\n[FATAL ERROR]', error);
    } finally {
        if (output) {
            try {
                await writeStream(output, '\n]\n');
                const finishedEvent = once(output, 'finish');
                output.end();
                await finishedEvent;
            } catch (error) {
                console.error('Output write error:', error.message);
                output.destroy();
            }
        }

        console.log('\n======================================');
        console.log('SCRAPING FINISHED');
        console.log('======================================');
        console.log(`Total entries: ${totalCardsExtracted}`);
        console.log(`Failed extractions: ${failedCards}`);
        console.log(`Last page reached: ${pageNum}`);
        console.log(`Output: ${OUTPUT_FILE}`);
        console.log('Duplicate filtering: OFF');
        console.log('======================================\n');
    }
}

scrapeShoobCards().catch(error => {
    console.error('Unexpected error:', error);
    process.exitCode = 1;
});
