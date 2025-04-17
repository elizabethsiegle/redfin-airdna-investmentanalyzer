import puppeteer, { Page } from "@cloudflare/puppeteer";
import { Hono } from 'hono';
import { serveStatic } from '@hono/node-server/serve-static'

export interface Env {
  MYBROWSER: any; // Browser binding for Cloudflare's Browser Rendering API
  BROWSER_KV_LV_HX: KVNamespace; // KV namespace for caching
  AI: Ai;
  [key: string]: any;
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
  imageUrl: string;
}

interface SearchParams {
  city: string;
  state: string;
  zip?: string;
  minPrice: number;
  maxPrice: number;
  minBeds: number;
  maxHOA: number;
  features: string[];
}

const app = new Hono<{ Bindings: Env }>();

// Serve static files from the assets directory
app.post('/', serveStatic({ root: './assets' }));

// Serve index.html for the root path
app.get('/', async (c) => {
  const html = await c.env.BROWSER_KV_LV_HX.get('index.html');
  if (!html) {
    return c.text('index.html not found', 404);
  }
  return c.html(html);
});

/**
 * Escapes a string to be safe for HTML content
 * @param str The string to escape
 * @returns The escaped string
 */
function escapeHtml(str: string): string {
  const htmlEscapes: { [key: string]: string } = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
    '/': '&#x2F;'
  };
  
  return str.replace(/[&<>"'/]/g, (match) => htmlEscapes[match]);
}

async function extractListings(page: Page): Promise<Listing[]> {
  const listings: Listing[] = [];
  
  // Wait for listings to load
  await page.waitForSelector('.HomeCardContainer', { timeout: 10000 });
  
  // Get all home card containers that are not ads
  const cards = await page.$$('.HomeCardContainer:not(.InlineResultStaticPlacement)');
  
  // Process listings
  for (const card of cards) {
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

      // Get the image URL
      const imageUrl = await card.$eval('.bp-Homecard__Photo--image', el => el.getAttribute('src') || '');

      const listing: Listing = {
        address,
        price,
        beds,
        baths, 
        sqft,
        hoa,
        features,
        url: fullUrl,
        imageUrl
      };
      
      listings.push(listing);
    } catch (err) {
      console.error(`Error extracting listing data: ${err}`);
      continue;
    }
  }

  return listings;
}

async function getCityId(city: string, state: string, c:any): Promise<string> {
    let browser;
    try {
        browser = await puppeteer.launch(c.env.MYBROWSER);
        const page = await browser.newPage();
        
        // First, search for the city
        const searchUrl = `https://www.redfin.com/city/${encodeURIComponent(city)}-${encodeURIComponent(state)}`;
        console.log('Searching for city ID with URL:', searchUrl);
        await page.goto(searchUrl, { waitUntil: 'networkidle0' });
        
        // Extract the city ID from the URL
        const currentUrl = page.url();
        const match = currentUrl.match(/\/city\/(\d+)\//);
        
        if (!match) {
            throw new Error('Could not find city ID');
        }
        
        return match[1];
    } finally {
        if (browser) {
            await browser.close();
        }
    }
}

// API endpoints
app.get('/api/listings', async (c) => {
    const params: SearchParams = {
        city: c.req.query('city') || '',
        state: c.req.query('state') || '',
        zip: c.req.query('zip') || '',
        minPrice: c.req.query('minPrice') ? Number(c.req.query('minPrice')) : 0,
        maxPrice: c.req.query('maxPrice') ? Number(c.req.query('maxPrice')) : 10000000,
        minBeds: c.req.query('minBeds') ? Number(c.req.query('minBeds')) : 0,
        maxHOA: c.req.query('maxHOA') ? Number(c.req.query('maxHOA')) : 10000,
        features: c.req.query('features')?.split(',') || []
    };

    if (!params.city || !params.state) {
        return c.json({ error: 'City and state are required' }, 400);
    }

    let browser;
    let searchUrl = '';
    try {
        // Get the city ID
        const cityId = await getCityId(params.city, params.state, c);
        
        // Construct the base URL
        let baseUrl = `https://www.redfin.com/city/${cityId}/${params.state}/${params.city}/filter`;
        if (params.zip) {
            baseUrl = `https://www.redfin.com/zipcode/${params.zip}/filter`;
        }

        // Construct the search URL with all parameters
        const urlParams: string[] = [];
        
        // Add price range
        if (params.minPrice > 0) {
            const minPriceK = Math.floor(params.minPrice / 1000);
            urlParams.push(`min-price=${minPriceK}k`);
        }
        if (params.maxPrice < 10000000) {
            const maxPriceK = Math.floor(params.maxPrice / 1000);
            urlParams.push(`max-price=${maxPriceK}k`);
        }
        
        // Add beds
        if (params.minBeds > 0) {
            urlParams.push(`min-beds=${params.minBeds}`);
        }
        
        // Add HOA
        if (params.maxHOA < 10000) {
            urlParams.push(`hoa=${params.maxHOA}`);
        }

        // Add features as remarks
        if (params.features.length > 0) {
            urlParams.push(`remarks=${params.features.join(',')}`);
        }

        searchUrl = `${baseUrl}/${urlParams.join(',')}`;
        console.log('Searching with URL:', searchUrl);

        // Initialize browser with specific options
        browser = await puppeteer.launch(c.env.MYBROWSER);
        const page = await browser.newPage();
        
        // Set a basic user agent
        await page.setUserAgent(
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36"
        );

        // Set viewport
        await page.setViewport({ width: 1920, height: 1080 });

        // Navigate directly to the URL
        await page.goto(searchUrl, {
            waitUntil: 'networkidle0',
            timeout: 30000
        });

        // Wait for listings to appear
        await page.waitForSelector('.HomeCardContainer', { timeout: 10000 });

        // Extract listings
        const listings = await page.evaluate(() => {
            const cards = document.querySelectorAll('.HomeCardContainer:not(.InlineResultStaticPlacement)');
            return Array.from(cards).map(card => {
                try {
                    const address = card.querySelector('.bp-Homecard__Content .bp-Homecard__Address')?.textContent?.trim() || '';
                    const priceText = card.querySelector('.bp-Homecard__Content .bp-Homecard__Price--value')?.textContent?.trim().replace('$','').replace(/,/g,'') || '0';
                    const price = parseInt(priceText);
                    
                    const bedsText = card.querySelector('.bp-Homecard__Stats--beds')?.textContent?.trim() || '0';
                    const bathsText = card.querySelector('.bp-Homecard__Stats--baths')?.textContent?.trim() || '0';
                    const sqftText = card.querySelector('.bp-Homecard__Stats--sqft')?.textContent?.trim() || '0';
                    
                    const beds = parseFloat(bedsText.replace(/[^0-9.]/g, '') || '0');
                    const baths = parseFloat(bathsText.replace(/[^0-9.]/g, '') || '0');
                    const sqft = parseInt(sqftText.replace(/[^0-9]/g, '') || '0');
                    
                    const hoaElement = Array.from(card.querySelectorAll('.KeyFactsExtension .KeyFacts-item'))
                        .find(el => el.textContent?.includes('HOA'));
                    const hoa = hoaElement ? parseInt(hoaElement.textContent?.replace(/[^0-9]/g, '') || '0') : undefined;
                    
                    const features = Array.from(card.querySelectorAll('.KeyFactsExtension .KeyFacts-item'))
                        .map(el => el.textContent?.trim() || '');
                    
                    const url = card.querySelector('.bp-Homecard__Photo')?.getAttribute('href') || '';
                    const fullUrl = `https://www.redfin.com${url}`;

                    // Get the image URL
                    const imageUrl = card.querySelector('.bp-Homecard__Photo--image')?.getAttribute('src') || '';

                    return {
                        address,
                        price,
                        beds,
                        baths,
                        sqft,
                        hoa,
                        features,
                        url: fullUrl,
                        imageUrl
                    };
                } catch (err) {
                    console.error('Error processing card:', err);
                    return null;
                }
            }).filter(Boolean);
        });

        if (!listings || listings.length === 0) {
            throw new Error('No listings found on page');
        }

        return c.json({
            source: searchUrl,
            timestamp: new Date().toISOString(),
            totalListings: listings.length,
            listings: listings
        });

    } catch (error) {
        console.error('Error during scraping:', error);
        return c.json({
            error: "Failed to fetch listings",
            message: error instanceof Error ? error.message : String(error),
            source: searchUrl
        }, 500);
    } finally {
        if (browser) {
            try {
                await browser.close();
            } catch (e) {
                console.error("Error closing browser:", e);
            }
        }
    }
});

// Add new endpoint for property financial analysis
app.get('/listings/financials', async (c) => {
  const address = c.req.query('address');
  if (!address) {
    return c.json({ error: 'Address is required' }, 400);
  }

  let browser;
  try {
    // Initialize browser
    browser = await puppeteer.launch(c.env.MYBROWSER);
    const page = await browser.newPage();
    
    // Set a basic user agent
    await page.setUserAgent(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36"
    );

    // Navigate to AirDNA rentalizer
    const url = `https://app.airdna.co/data/rentalizer?address=${encodeURIComponent(address)}`;
    await page.goto(url, {
      waitUntil: 'networkidle0',
      timeout: 30000
    });

    // Wait for the data to load
    await page.waitForSelector('h3.MuiTypography-root.MuiTypography-titleM.css-sd2qa2', { timeout: 10000 });

    // Extract the financial data
    const financialData = await page.evaluate(() => {
      const getValue = (selector: string) => {
        const element = document.querySelector(selector);
        return element ? element.textContent?.trim().replace(/[^0-9.]/g, '') : null;
      };

      const priceElement = document.querySelector('h3.MuiTypography-root.MuiTypography-titleM.css-sd2qa2');
      const price = priceElement ? parseFloat(priceElement.textContent?.replace(/[^0-9.]/g, '') || '0') : 0;

      return {
        estimatedRent: price,
        occupancyRate: parseFloat(getValue('.occupancy-rate') || '0'),
        revenuePotential: parseFloat(getValue('.revenue-potential') || '0')
      };
    });

    return c.json(financialData);

  } catch (error) {
    console.error('Error fetching financial data:', error);
    return c.json({
      error: 'Failed to fetch financial data',
      message: error instanceof Error ? error.message : String(error)
    }, 500);
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch (e) {
        console.error("Error closing browser:", e);
      }
    }
  }
});

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    return app.fetch(request, env, ctx);
  },
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    console.log("cron processed");
  }
} satisfies ExportedHandler<Env>;