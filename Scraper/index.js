const puppeteer = require('puppeteer');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');
const { once } = require('events');

const SCRAPE_EVENTS = true;
const BASE_URL = 'https://shoob.gg';
const NORMAL_OUTPUT_FILE = path.join(__dirname, 'Shoob-Cards.json');

const CONCURRENCY = 5;
const PAGES_PER_SESSION = 10;
const PAGE_TIMEOUT = 45000;
const SELECTOR_TIMEOUT = 15000;
const MAX_RETRIES = 3;
const RETRY_DELAY = 500;

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function absoluteUrl(url) {
    if (!url) return null;
    try {
        return new URL(url, BASE_URL).href;
    } catch {
        return null;
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
        if (request.isInterceptResolutionHandled()) return;
        const type = request.resourceType();

        if (['image', 'media', 'font', 'stylesheet'].includes(type)) {
            request.abort().catch(() => {});
        } else {
            request.continue().catch(() => {});
        }
    });
}

async function launchBrowser() {
    return puppeteer.launch({
        headless: 'new',
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-background-networking',
            '--disable-extensions',
            '--disable-sync',
            '--disable-default-apps',
            '--js-flags=--max-old-space-size=256'
        ]
    });
}

async function getEventTargets() {
    console.log('\n[INFO] Fetching active events...');
    let browser;

    try {
        browser = await launchBrowser();
        const page = await browser.newPage();
        await optimizePage(page);

        await page.goto(`${BASE_URL}/card-events`, {
            waitUntil: 'networkidle2',
            timeout: PAGE_TIMEOUT
        });

        try {
            await page.waitForSelector('a[href^="/card-events/"]', {
                timeout: SELECTOR_TIMEOUT
            });
            await delay(1000);
        } catch {
            console.log('[WARNING] Event links were not detected.');
        }

        const html = await page.content();
        const $ = cheerio.load(html);
        const eventSlugs = [];

        $('a[href^="/card-events/"]').each((i, el) => {
            const href = $(el).attr('href');
            if (!href) return;

            try {
                const pathname = new URL(href, BASE_URL).pathname;
                const parts = pathname.split('/').filter(Boolean);

                if (
                    parts.length === 2 &&
                    parts[0] === 'card-events' &&
                    /^[a-zA-Z0-9_-]+$/.test(parts[1])
                ) {
                    eventSlugs.push(parts[1]);
                }
            } catch {}
        });

        console.log(`[INFO] Found ${eventSlugs.length} event link occurrences.`);

        const slugCounts = {};

        return eventSlugs.map(slug => {
            slugCounts[slug] = (slugCounts[slug] || 0) + 1;

            const occurrence = slugCounts[slug];
            const suffix = occurrence > 1 ? `-${occurrence}` : '';

            return {
                baseUrl: `${BASE_URL}/card-events/${slug}`,
                outputFile: path.join(
                    __dirname,
                    `Shoob-Event-${slug}${suffix}.json`
                ),
                name: `Event: ${slug} (Occurrence ${occurrence})`
            };
        });
    } catch (error) {
        console.error(`[EVENT DISCOVERY ERROR] ${error.message}`);
        return [];
    } finally {
        if (browser) {
            await browser.close().catch(error => {
                console.error(`[EVENT BROWSER CLOSE] ${error.message}`);
            });
        }
    }
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

    if (cardDetailUrl.includes('/card-events/')) {
        cardData.eventName = $('.page-breadcrumb li').eq(2).text().trim();
        cardData.series = $('.fff').first().text().trim() || 'Event Exclusive';
    } else {
        let seriesName = $('.page-breadcrumb li').eq(2).text().trim();
        if (!seriesName) seriesName = $('.fff').first().text().trim();
        cardData.series = seriesName;
    }

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
                waitUntil: 'networkidle2',
                timeout: PAGE_TIMEOUT
            });

            await page.waitForSelector('.cardData', {
                timeout: SELECTOR_TIMEOUT
            });

            await delay(800);

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

async function scrapeTarget(target) {
    console.log(`\n>>>>>>>> STARTING TARGET: ${target.name} <<<<<<<<\n`);

    let output;
    let pageNum = 1;
    let totalCardsExtracted = 0;
    let failedCards = 0;
    let isFirstCard = true;
    let finished = false;
    let fatalError = null;

    try {
        output = fs.createWriteStream(target.outputFile, { encoding: 'utf8' });
        await once(output, 'open');
        await writeStream(output, '[\n');

        while (!finished) {
            let browser;
            let sessionPagesCompleted = 0;

            try {
                console.log(`\n[SESSION] ${target.name}`);
                console.log(`[START PAGE] ${pageNum}`);

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
                    const pageUrl = `${target.baseUrl}?page=${pageNum}`;

                    console.log(`\n[PAGE ${pageNum}] ${pageUrl}`);

                    let cardLinks = [];

                    try {
                        await listPage.goto(pageUrl, {
                            waitUntil: 'networkidle2',
                            timeout: PAGE_TIMEOUT
                        });

                        try {
                            await listPage.waitForSelector('.card-main a', {
                                timeout: SELECTOR_TIMEOUT
                            });
                            await delay(1000);
                        } catch {
                            console.log('[INFO] No cards found. Ending target.');
                            finished = true;
                            break;
                        }

                        const $ = cheerio.load(await listPage.content());

                        $('.card-main a').each((i, el) => {
                            const href = $(el).attr('href');
                            if (href) {
                                const url = absoluteUrl(href);
                                if (url) cardLinks.push(url);
                            }
                        });
                    } catch (error) {
                        console.error(`[PAGE ERROR] ${error.message}`);
                        fatalError = error;
                        finished = true;
                        break;
                    }

                    if (!cardLinks.length) {
                        console.log('[INFO] No more card links.');
                        finished = true;
                        break;
                    }

                    console.log(`[INFO] Found ${cardLinks.length} card link occurrences.`);

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
                                const prefix = isFirstCard ? '' : ',\n';
                                isFirstCard = false;

                                await writeStream(output, prefix + json);

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
            } catch (error) {
                console.error(`[SESSION ERROR] ${error.message}`);
                fatalError = error;
                finished = true;
            } finally {
                if (browser) {
                    console.log('[RECYCLE] Closing Chromium...');

                    await browser.close().catch(error => {
                        console.error(`[BROWSER CLOSE ERROR] ${error.message}`);
                    });

                    browser = null;
                    console.log('[RECYCLE] Chromium closed.');
                }
            }

            if (!finished && sessionPagesCompleted === PAGES_PER_SESSION) {
                console.log(`[RECYCLE] Completed through page ${pageNum - 1}.`);
                console.log(`[RECYCLE] Resuming from page ${pageNum}.`);
            }
        }
    } catch (error) {
        fatalError = error;
        console.error(`[FATAL ERROR] ${target.name}: ${error.message}`);
    } finally {
        if (output) {
            try {
                await writeStream(output, '\n]\n');
                const finishedEvent = once(output, 'finish');
                output.end();
                await finishedEvent;
            } catch (error) {
                console.error(`[OUTPUT ERROR] ${error.message}`);
                output.destroy();
            }
        }

        console.log('\n======================================');
        console.log(`FINISHED TARGET: ${target.name}`);
        console.log(`Total entries: ${totalCardsExtracted}`);
        console.log(`Failed extractions: ${failedCards}`);
        console.log(`Last page reached: ${pageNum}`);
        console.log(`Output File: ${target.outputFile}`);
        if (fatalError) console.log(`Stopped due to: ${fatalError.message}`);
        console.log('Duplicate filtering: OFF');
        console.log('======================================\n');
    }
}

async function mainScraperController() {
    console.log('\n======================================');
    console.log('Shoob.gg Universal Scraper');
    console.log('======================================');
    console.log(`Mode: ${SCRAPE_EVENTS ? 'EVENTS' : 'NORMAL CARDS'}`);
    console.log(`Concurrency: ${CONCURRENCY} Tabs`);
    console.log(`Browser Recycling: Every ${PAGES_PER_SESSION} Pages`);
    console.log('Event duplicate filtering: OFF');
    console.log('Card duplicate filtering: OFF');
    console.log('Incomplete card filtering: OFF');
    console.log('Media downloads: OFF');
    console.log('======================================\n');

    let targets = [];

    if (SCRAPE_EVENTS) {
        targets = await getEventTargets();

        console.log(`[INFO] Loaded ${targets.length} event targets.`);

        if (!targets.length) {
            console.log('[INFO] No events found. Exiting.');
            return;
        }
    } else {
        targets = [{
            baseUrl: `${BASE_URL}/cards`,
            outputFile: NORMAL_OUTPUT_FILE,
            name: 'Normal Database'
        }];
    }

    for (const target of targets) {
        await scrapeTarget(target);
    }

    console.log('\n======================================');
    console.log('ALL SCRAPING TASKS COMPLETED');
    console.log('======================================');
}

mainScraperController().catch(error => {
    console.error('[UNEXPECTED ERROR]', error);
    process.exitCode = 1;
});
