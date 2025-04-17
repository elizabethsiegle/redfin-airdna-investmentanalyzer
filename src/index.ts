import puppeteer, { Page, Browser } from "@cloudflare/puppeteer";
import { Hono } from 'hono';
import { serveStatic } from '@hono/node-server/serve-static'

export interface Env {
  MYBROWSER: any;
  BROWSER_KV_LV_HX: KVNamespace;
  AI: Ai;
  AIRDNA_API_KEY?: string; // Add AirDNA API key to your env variables
}

interface Listing {
  address: string;
  price: number;
  beds: number;
  baths: number;
  sqft: number;
  hoa?: number;
  features: string[];
  url: string;
  monthlyCost?: number; // Estimated monthly payment
  monthlyRent?: number; // Estimated rental income
  airDnaNOI?: number; // Net Operating Income from AirDNA
  roi?: number; // Return on Investment
  cashFlow?: number; // Monthly cash flow (rent - monthly cost)
  imageUrl?: string;
}

interface SearchParams {
  minPrice?: number;
  maxPrice?: number;
  minBeds?: number;
  maxHOA?: number;
  features?: string[];
}

const app = new Hono<{ Bindings: Env }>();

// Helper function to get monthly cost from property detail page
async function getMonthlyCost(browser: Browser, propertyUrl: string): Promise<number | undefined> {
  try {
    const rentPage = await browser.newPage();
    await rentPage.goto(propertyUrl, { waitUntil: 'networkidle2', timeout: 60000 });
    await rentPage.waitForTimeout(2000);

    // Handle Cloudflare challenge if it appears
    try {
      await rentPage.waitForSelector('#challenge-form', { timeout: 5000 });
      console.log('Cloudflare challenge detected, waiting for resolution...');
      await rentPage.waitForFunction(() => {
        return document.querySelector('#challenge-form') === null;
      }, { timeout: 30000 });
    } catch (e) {
      console.log('No Cloudflare challenge detected');
    }

    // Wait for the monthly cost element to load
    await rentPage.waitForSelector('#content > div.detailsContent > div.theRailSection > div.alongTheRail > div:nth-child(1) > section > div > div > div > div.flex-1 > div.AddressBannerV2.desktop > div > div > div > div > div:nth-child(1) > span > div > span.est-monthly-payment.est-monthly-payment-synced > span', { timeout: 10000 });

    // Extract the text content
    const costText = await rentPage.$eval('#content > div.detailsContent > div.theRailSection > div.alongTheRail > div:nth-child(1) > section > div > div > div > div.flex-1 > div.AddressBannerV2.desktop > div > div > div > div > div:nth-child(1) > span > div > span.est-monthly-payment.est-monthly-payment-synced > span', el => {
      const text = el.textContent?.trim() || '';
      // Extract numeric value from text (e.g., "$2,345/month" → 2345)
      const match = text.match(/\$?([\d,]+)/);
      return match ? match[1].replace(/,/g, '') : '0';
    });

    await rentPage.close();
    return costText ? parseInt(costText) : undefined;
  } catch (error) {
    console.error('Error getting monthly cost:', error);
    return undefined;
  }
}

// Function to get AirDNA data by scraping the direct Rentalizer URL
async function getAirDnaData(address: string, beds: number, baths: number, env: Env, browser: Browser): Promise<{ monthlyRent: number; noi: number } | undefined> {
  try {
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36');

    // Build AirDNA Rentalizer URL
    const encodedAddress = encodeURIComponent(address);
    const url = `https://app.airdna.co/data/rentalizer?address=${encodedAddress}&welcome=true&bedrooms=${beds}&bathrooms=${baths}`;
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
    await page.waitForTimeout(2000);

    // Wait for the NOI element to load
    await page.waitForSelector('h3.MuiTypography-titleM', { timeout: 40000 });

    // Extract NOI value
    const noi = await page.evaluate(() => {
      const noiElement = document.querySelector('h3.MuiTypography-titleM');
      console.log(`noiElement: ${noiElement}`);
      if (!noiElement) return 0;
      const text = noiElement.textContent || '';
      console.log(`text: ${text}`);
      // Extract numeric value from text (e.g., "$41K" → 41000)
      const match = text.match(/\$([\d.]+)K?/i);
      console.log(`match: ${match}`);
      if (!match) return 0;
      const value = parseFloat(match[1]);
      return text.toLowerCase().includes('k') ? value * 1000 : value;
    });

    // Extract monthly rent (Annual Revenue / 12)
    const monthlyRent = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="earnings-potential"]');
      if (!el) return 0;
      const text = el.textContent || '';
      const match = text.match(/\$([\d,]+)/);
      if (!match) return 0;
      const annual = parseInt(match[1].replace(/,/g, ''));
      return Math.round(annual / 12);
    });

    await page.close();
    return { monthlyRent, noi };
  } catch (error) {
    console.error('Error getting AirDNA data:', error);
    return undefined;
  }
}

async function extractListings(page: Page, env: Env): Promise<Listing[]> {
  const listings: Listing[] = [];
  
  await page.waitForSelector('.HomeCardContainer', { timeout: 10000 });
  const cards = await page.$$('.HomeCardContainer:not(.InlineResultStaticPlacement)');
  const cardsToProcess = cards.slice(0, 2); // Limit to 2 listings for now
  
  const browser = await puppeteer.launch(env.MYBROWSER);
  
  // Process listings serially
  for (const card of cardsToProcess) {
    try {
      const address = await card.$eval('.bp-Homecard__Content .bp-Homecard__Address', 
        el => el.textContent?.trim() || '');
        
      const priceText = await card.$eval('.bp-Homecard__Content .bp-Homecard__Price--value', 
        el => el.textContent?.trim().replace('$','').replace(/,/g,'') || '0');
      const price = parseInt(priceText);

      const bedsText = await card.$eval('.bp-Homecard__Stats--beds', el => 
        el.textContent?.trim() || '0');
      const bathsText = await card.$eval('.bp-Homecard__Stats--baths', el => 
        el.textContent?.trim() || '0');
      const sqftText = await card.$eval('.bp-Homecard__Stats--sqft', el => 
        el.textContent?.trim() || '0');

      const beds = parseFloat(bedsText.replace(/[^0-9.]/g, '') || '0');
      const baths = parseFloat(bathsText.replace(/[^0-9.]/g, '') || '0');
      const sqft = parseInt(sqftText.replace(/[^0-9]/g, '') || '0');

      const hoaText = await card.$eval('.KeyFactsExtension .KeyFacts-item', el => 
        el.textContent?.includes('HOA') ? el.textContent.replace(/[^0-9]/g, '') : null
      ).catch(() => null);
      const hoa = hoaText ? parseInt(hoaText) : undefined;

      const features = await card.$$eval('.KeyFactsExtension .KeyFacts-item', items =>
        items.map(item => item.textContent?.trim() || '')
      );

      const url = await card.$eval('.bp-Homecard__Photo', el => el.getAttribute('href') || '');
      const fullUrl = `https://www.redfin.com${url}`;

      // Create initial listing with basic info
      const listing: Listing & { imageUrl?: string } = {
        address,
        price,
        beds,
        baths, 
        sqft,
        hoa,
        features,
        url: fullUrl,
        monthlyCost: undefined,
        monthlyRent: undefined,
        airDnaNOI: undefined,
        cashFlow: undefined,
        roi: undefined,
        imageUrl: undefined
      };

      // Add to listings array immediately
      listings.push(listing);
      console.log(`listings: ${JSON.stringify(listings)}`);

      // Get monthly cost
      try {
        listing.monthlyCost = await getMonthlyCost(browser, fullUrl);
      } catch (error) {
        console.error('Error getting monthly cost:', error);
      }

      // Get Redfin image with timeout
      try {
        listing.imageUrl = await Promise.race<string | undefined>([
          getRedfinImage(fullUrl, browser),
          new Promise<undefined>((_, reject) => setTimeout(() => reject(new Error('Image timeout')), 30000))
        ]);
      } catch (error) {
        console.error('Error getting Redfin image:', error);
      }

    } catch (err) {
      console.error(`Error extracting listing data: ${err}`);
      continue;
    }
  }

  await browser.close();
  return listings;
}

// New function to update listings with AirDNA data
async function updateListingsWithAirDnaData(listings: Listing[], env: Env): Promise<void> {
  const browser = await puppeteer.launch(env.MYBROWSER);
  
  for (const listing of listings) {
    try {
      const airDnaData = await Promise.race<{ monthlyRent: number; noi: number } | undefined>([
        getAirDnaData(listing.address, listing.beds, listing.baths, env, browser),
        new Promise<undefined>((_, reject) => setTimeout(() => reject(new Error('AirDNA timeout')), 30000))
      ]);

      if (airDnaData) {
        listing.monthlyRent = airDnaData.monthlyRent;
        listing.airDnaNOI = airDnaData.noi;
        
        // Calculate ROI and cash flow if we have both cost and rent data
        if (listing.monthlyCost && listing.monthlyRent) {
          listing.cashFlow = listing.monthlyRent - listing.monthlyCost;
          listing.roi = (listing.cashFlow * 12) / listing.price * 100;
        }
      }
    } catch (error) {
      console.error('Error getting AirDNA data:', error);
    }
  }

  await browser.close();
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    
    // Serve static files from assets directory
    if (url.pathname === '/' || url.pathname === '/index.html') {
      return new Response(await env.BROWSER_KV_LV_HX.get('index.html') || '', {
        headers: {
          'content-type': 'text/html',
        },
      });
    }

    // Serve other static assets
    if (url.pathname.startsWith('/assets/')) {
      const assetPath = url.pathname.replace('/assets/', '');
      const asset = await env.BROWSER_KV_LV_HX.get(assetPath);
      console.log(`assetPath: ${assetPath}`);
      if (asset) {
        return new Response(asset, {
          headers: {
            'content-type': getContentType(assetPath),
          },
        });
      }
    }

    if (url.pathname === "/api/listings") {
      const params: SearchParams = {
        minPrice: url.searchParams.get('minPrice') ? Number(url.searchParams.get('minPrice')) : undefined,
        maxPrice: url.searchParams.get('maxPrice') ? Number(url.searchParams.get('maxPrice')) : undefined,
        minBeds: url.searchParams.get('minBeds') ? Number(url.searchParams.get('minBeds')) : undefined,
        maxHOA: url.searchParams.get('maxHOA') ? Number(url.searchParams.get('maxHOA')) : undefined,
        features: url.searchParams.get('features')?.split(',') || undefined
      };

      const targetUrl = "https://www.redfin.com/city/34945/HI/Honolulu";

      try {
        const normalizedUrl = new URL(targetUrl).toString();
        const cacheKey = normalizedUrl;
        let cachedResults = null; // Always scrape fresh for now

        if (cachedResults === null) {
          const browser = await puppeteer.launch(env.MYBROWSER);
          const page = await browser.newPage();

          await page.setUserAgent(
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36"
          );

          await page.setViewport({ width: 1920, height: 1080 });

          await Promise.race([
            page.goto(normalizedUrl, { waitUntil: "domcontentloaded", timeout: 15000 }),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Navigation timeout')), 15000))
          ]);

          await page.waitForTimeout(3000); // wait 3 seconds for images to load

          const listings = await extractListings(page, env);
          
          if (listings.length === 0) {
            await browser.close();
            return new Response(
              JSON.stringify({
                error: "No listings found",
                message: "Could not find any property listings on the page."
              }),
              {
                headers: { "content-type": "application/json" },
                status: 404
              }
            );
          }

          const results = {
            source: normalizedUrl,
            timestamp: new Date().toISOString(),
            totalListings: listings.length,
            listings: listings
          };
          console.log(`results: ${JSON.stringify(results)}`);

          await env.BROWSER_KV_LV_HX.put(cacheKey, JSON.stringify(results), {
            expirationTtl: 60 * 60
          });

          await browser.close();

          // Start AirDNA data fetching in the background
          ctx.waitUntil(updateListingsWithAirDnaData(listings, env));

          return new Response(JSON.stringify(results), {
            headers: { "content-type": "application/json" }
          });
        } else {
          return new Response(JSON.stringify(cachedResults), {
            headers: {
              "content-type": "application/json",
              "x-cache": "HIT"
            }
          });
        }
      } catch (error) {
        console.error("Error:", error);
        return new Response(
          JSON.stringify({
            error: "Failed to scrape Redfin",
            message: error instanceof Error ? error.message : String(error)
          }),
          {
            headers: { "content-type": "application/json" },
            status: 500
          }
        );
      }
    } else {
      return new Response(
        JSON.stringify({
          error: "Not Found",
          message: "The requested path does not exist.",
        }),
        {
          headers: { "content-type": "application/json" },
          status: 404,
        }
      );
    }
  },
  async scheduled(
    controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ) {
    console.log("cron processed");
  },
} satisfies ExportedHandler<Env>;

app.post('/api/extract-image', async (c) => {
  const { url, xpath } = await c.req.json();
  
  try {
      // Launch browser using Cloudflare's Browser Rendering
      const browser = await puppeteer.launch(c.env.MYBROWSER);
      const page = await browser.newPage();
      
      // Set realistic browser headers
      await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36');
      
      // Navigate to the Redfin listing
      await page.goto(url, { 
          waitUntil: 'networkidle2', 
          timeout: 30000 
      });
      
      // Handle Cloudflare challenges if they appear
      try {
          await page.waitForSelector('#challenge-form', { timeout: 5000 });
          console.log('Cloudflare challenge detected, waiting...');
          await page.waitForFunction(() => {
              return document.querySelector('#challenge-form') === null;
          }, { timeout: 30000 });
      } catch (e) {
          console.log('No Cloudflare challenge detected');
      }
      
      // Extract image URL from the specified XPath
      const imageUrl = await page.evaluate((xpath) => {
          try {
              const result = document.evaluate(
                  xpath, 
                  document, 
                  null, 
                  XPathResult.FIRST_ORDERED_NODE_TYPE, 
                  null
              );
              const element = result.singleNodeValue as HTMLElement;
              
              if (element) {
                  // For meta tags (like Redfin's meta[17])
                  if (element.tagName === 'META') {
                      const meta = element as HTMLMetaElement;
                      return meta.content;
                  }
                  // For img tags
                  if (element.tagName === 'IMG') {
                      const img = element as HTMLImageElement;
                      return img.src;
                  }
              }
              return null;
          } catch (e) {
              console.error('XPath evaluation error:', e);
              return null;
          }
      }, xpath);
      
      await browser.close();
      
      if (!imageUrl) {
          return c.json({ 
              error: 'Image not found at specified XPath' 
          }, 404);
      }
      
      // Return absolute URL if relative
      const absoluteUrl = new URL(imageUrl, url).toString();
      return c.json({ imageUrl: absoluteUrl });
      
  } catch (error) {
      console.error('Error extracting image:', error);
      return c.json({ 
          error: 'Failed to extract image',
          message: error 
      }, 500);
  }
});

// Helper to extract image from Redfin listing using Puppeteer and <link rel="preload" as="image"> or meta tag
async function getRedfinImage(listingUrl: string, browser: Browser): Promise<string | undefined> {
  try {
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36');
    await page.goto(listingUrl, { waitUntil: 'networkidle2', timeout: 20000 });

    // Wait extra time for images to load
    await page.waitForTimeout(3000);

    // Wait for the image preload link to appear
    await page.waitForSelector('link[rel="preload"][as="image"]', { timeout: 10000 }).catch(() => {});

    // Try to get the image from <link rel="preload" as="image" ...>
    let imageUrl = await page.evaluate(() => {
      const link = document.querySelector('link[rel="preload"][as="image"]') as HTMLLinkElement | null;
      return link ? link.href : undefined;
    });

    // Fallback to meta tag if not found
    if (!imageUrl) {
      imageUrl = await page.evaluate(() => {
        const m = document.querySelector('meta[name="twitter:image"]') as HTMLMetaElement | null;
        return m ? m.content : undefined;
      });
    }

    await page.close();
    return imageUrl;
  } catch (error) {
    console.error('Error extracting Redfin image:', error);
    return undefined;
  }
}

app.post('/api/analyze', async (c) => {
  try {
    const listings = await c.req.json();
    // Get AirDNA data and Redfin image for each listing
    const analyzedListings = await Promise.all(listings.map(async (listing: Listing) => {
      const airDnaData = await getAirDnaData(listing.address, listing.beds, listing.baths, c.env, c.env.MYBROWSER);
      const imageUrl = await getRedfinImage(listing.url, c.env.MYBROWSER);
      // Update listing with AirDNA data and image
      const updatedListing = {
        ...listing,
        monthlyRent: airDnaData?.monthlyRent,
        airDnaNOI: airDnaData?.noi,
        imageUrl
      };
      // Calculate ROI and cash flow if we have both cost and rent data
      let cashFlow, roi;
      if (updatedListing.monthlyCost && updatedListing.monthlyRent) {
        cashFlow = updatedListing.monthlyRent - updatedListing.monthlyCost;
        roi = (cashFlow * 12) / updatedListing.price * 100; // Annual ROI percentage
      }
      let analysis = '';
      if (cashFlow && roi) {
        if (cashFlow > 0) {
          analysis = `Good investment opportunity! Positive cash flow of $${cashFlow}/month (ROI: ${roi.toFixed(1)}%).`;
        } else {
          analysis = `Negative cash flow of $${Math.abs(cashFlow)}/month. Consider negotiating price or finding higher rental income.`;
        }
      } else {
        analysis = 'Incomplete financial data. Unable to calculate ROI.';
      }
      return {
        ...updatedListing,
        cashFlow,
        roi,
        analysis
      };
    }));
    // Get AI summary
    const messages = [
      { role: "system", content: "You are a real estate investment analyst. Provide concise insights about these properties." },
      {
        role: "user",
        content: `Analyze these properties for investment potential: ${JSON.stringify(analyzedListings)}`,
      },
    ];
    const aiAnalysis = await c.env.AI.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", { messages });
    return c.json({ 
      listings: analyzedListings,
      summary: aiAnalysis 
    });
  } catch (error) {
    console.error('Error generating analysis:', error);
    return c.json({ error: 'Failed to generate analysis' }, 500);
  }
});

// New endpoint for fetching AirDNA data for a specific listing
app.get('/api/airdna/:address', async (c) => {
  const address = decodeURIComponent(c.req.param('address'));
  const beds = parseInt(c.req.query('beds') || '0');
  const baths = parseInt(c.req.query('baths') || '0');
  
  try {
    const browser = await puppeteer.launch(c.env.MYBROWSER);
    const airDnaData = await Promise.race<{ monthlyRent: number; noi: number } | undefined>([
      getAirDnaData(address, beds, baths, c.env, browser),
      new Promise<undefined>((_, reject) => setTimeout(() => reject(new Error('AirDNA timeout')), 30000))
    ]);
    
    await browser.close();
    
    if (!airDnaData) {
      return c.json({ error: 'Failed to fetch AirDNA data' }, 500);
    }
    
    return c.json(airDnaData);
  } catch (error) {
    console.error('Error fetching AirDNA data:', error);
    return c.json({ error: 'Failed to fetch AirDNA data' }, 500);
  }
});

// Update the main listings endpoint to return data immediately
app.get('/api/listings', async (c) => {
  try {
    const browser = await puppeteer.launch(c.env.MYBROWSER);
    const page = await browser.newPage();
    
    await page.goto('https://www.redfin.com/city/34945/HI/Honolulu', { 
      waitUntil: 'networkidle2',
      timeout: 30000 
    });
    
    const listings = await extractListings(page, c.env);
    await browser.close();
    
    // Return listings immediately without AirDNA data
    return c.json({ listings });
  } catch (error) {
    console.error('Error fetching listings:', error);
    return c.json({ error: 'Failed to fetch listings' }, 500);
  }
});

// Helper function to determine content type
function getContentType(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'html': return 'text/html';
    case 'css': return 'text/css';
    case 'js': return 'application/javascript';
    case 'json': return 'application/json';
    case 'png': return 'image/png';
    case 'jpg':
    case 'jpeg': return 'image/jpeg';
    case 'gif': return 'image/gif';
    case 'svg': return 'image/svg+xml';
    default: return 'text/plain';
  }
}