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

// API routes middleware
app.use('/api/*', async (c, next) => {
    c.header('Content-Type', 'application/json');
    await next();
});

// Serve static files from the assets directory
app.use('/*', serveStatic({ root: './assets' }));

// Serve index.html for the root path
app.get('/', async (c) => {
    const html = await c.env.BROWSER_KV_LV_HX.get('index.html');
    if (!html) {
        return c.text('index.html not found', 404);
    }
    return c.html(html);
});


async function extractListings(page: Page): Promise<Listing[]> {
  const listings: Listing[] = [];
  
  try {
    // Wait for either the listings container or a "no results" message
    await Promise.race([
      page.waitForSelector('.HomeCardContainer', { timeout: 15000 }),
      page.waitForSelector('.no-results-message', { timeout: 15000 })
    ]);

    // Check if we have a "no results" message
    const noResults = await page.$('.no-results-message');
    if (noResults) {
      console.log('No listings found for this search');
      return listings;
    }

    // Get all home card containers that are not ads
    const cards = await page.$$('.HomeCardContainer:not(.InlineResultStaticPlacement)');
    
    if (cards.length === 0) {
      console.log('No listings found for this search');
      return listings;
    }

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
  } catch (error) {
    console.error('Error in extractListings:', error);
    // Return empty array instead of throwing to allow the request to complete
    return listings;
  }

  return listings;
}


// API endpoints
app.get('/api/listings', async (c) => {
    let browser;
    try {
        // Get query parameters
        const zip = c.req.query('zip');
        const city = c.req.query('city');
        const state = c.req.query('state');
        const minPrice = parseInt(c.req.query('minPrice') || '0');
        const maxPrice = parseInt(c.req.query('maxPrice') || '10000000');
        const minBeds = parseInt(c.req.query('minBeds') || '0');
        const maxHOA = parseInt(c.req.query('maxHOA') || '10000');
        const features = c.req.query('features')?.split(',') || [];

        let searchZipcode: string;

        // If zipcode is provided, use it directly
        if (zip) {
            searchZipcode = zip;
        } 
        // If city and state are provided, get the zipcode from LLM
        else if (city && state) {
            const messages = [
                { role: "system", content: "You are a helpful assistant that provides zipcodes for US cities. Only respond with the zipcode number, nothing else." },
                {
                    role: "user",
                    content: `What is the main zipcode for ${city}, ${state}? Only respond with the zipcode number.`,
                },
            ];

            const response = await c.env.AI.run("@cf/meta/llama-4-scout-17b-16e-instruct", { messages });
            searchZipcode = (response as any).response?.trim() || '';
            
            // Validate the zipcode format
            if (!/^\d{5}$/.test(searchZipcode)) {
                return c.json({ 
                    error: 'Could not determine a valid zipcode for the specified city and state. Please try a different city or enter a zipcode directly.' 
                }, 400);
            }
        } else {
            return c.json({ error: 'Either zipcode or city and state are required' }, 400);
        }

        // Construct the search URL with the zipcode
        let searchUrl = `https://www.redfin.com/zipcode/${searchZipcode}/filter`;

        // Add filters to the URL
        const filters = [];
        if (minPrice > 0) filters.push(`min-price=${Math.floor(minPrice/1000)}k`);
        if (maxPrice > 0) filters.push(`max-price=${Math.floor(maxPrice/1000)}k`);
        if (minBeds > 0) filters.push(`min-beds=${minBeds}`);
        if (maxHOA < 10000) filters.push(`hoa=${maxHOA}`);
        if (features.length > 0) filters.push(`remarks=${features.join(',')}`);

        if (filters.length > 0) {
            searchUrl += `/${filters.join(',')}`;
        }

        console.log('Searching with URL:', searchUrl);

        // Initialize browser
        browser = await puppeteer.launch(c.env.MYBROWSER);
        const page = await browser.newPage();
        
        // Set a basic user agent
        await page.setUserAgent(
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36"
        );

        // Navigate to the search URL
        await page.goto(searchUrl, {
            waitUntil: 'networkidle0',
            timeout: 30000
        });

        // Wait for either listings or no results message with increased timeout
        try {
            await Promise.race([
                page.waitForSelector('.HomeCardContainer', { timeout: 20000 }),
                page.waitForSelector('.no-results-message', { timeout: 20000 }),
                page.waitForSelector('.bp-Homecard', { timeout: 20000 }) // Alternative selector
            ]);

            // Check if we have a "no results" message
            const noResults = await page.$('.no-results-message');
            if (noResults) {
                return c.json({
                    source: searchUrl,
                    timestamp: new Date().toISOString(),
                    totalListings: 0,
                    listings: [],
                    message: 'No listings found matching your criteria'
                }, 200, {
                    'Content-Type': 'application/json'
                });
            }

            // Try to find listings using multiple possible selectors
            const listings = await page.$$('.HomeCardContainer');
            
            if (listings.length === 0) {
                return c.json({
                    source: searchUrl,
                    timestamp: new Date().toISOString(),
                    totalListings: 0,
                    listings: [],
                    message: 'No listings found matching your criteria'
                }, 200, {
                    'Content-Type': 'application/json'
                });
            }

            // Extract listings data
            const extractedListings = await Promise.all(listings.map(async (listing) => {
                try {
                    const address = await listing.$eval('.bp-Homecard__Content .bp-Homecard__Address', 
                        el => el.textContent?.trim() || '').catch(() => '');
                    
                    const priceText = await listing.$eval('.bp-Homecard__Content .bp-Homecard__Price--value', 
                        el => el.textContent?.trim().replace('$','').replace(/,/g,'') || '0').catch(() => '0');
                    const price = parseInt(priceText);

                    const bedsText = await listing.$eval('.bp-Homecard__Stats--beds', el => 
                        el.textContent?.trim() || '0').catch(() => '0');
                    const bathsText = await listing.$eval('.bp-Homecard__Stats--baths', el => 
                        el.textContent?.trim() || '0').catch(() => '0');
                    const sqftText = await listing.$eval('.bp-Homecard__Stats--sqft', el => 
                        el.textContent?.trim() || '0').catch(() => '0');

                    const beds = parseFloat(bedsText.replace(/[^0-9.]/g, '') || '0');
                    const baths = parseFloat(bathsText.replace(/[^0-9.]/g, '') || '0');
                    const sqft = parseInt(sqftText.replace(/[^0-9]/g, '') || '0');

                    const hoaText = await listing.$eval('.KeyFactsExtension .KeyFacts-item', el => 
                        el.textContent?.includes('HOA') ? el.textContent.replace(/[^0-9]/g, '') : null
                    ).catch(() => null);
                    const hoa = hoaText ? parseInt(hoaText) : undefined;

                    const features = await listing.$$eval('.KeyFactsExtension .KeyFacts-item', items =>
                        items.map(item => item.textContent?.trim() || '')
                    ).catch(() => []);

                    const url = await listing.$eval('.bp-Homecard__Photo', el => el.getAttribute('href') || '').catch(() => '');
                    const fullUrl = `https://www.redfin.com${url}`;

                    const imageUrl = await listing.$eval('.bp-Homecard__Photo--image', el => el.getAttribute('src') || '').catch(() => '');

                    // Only return a listing if we have at least an address and price
                    if (address && price > 0) {
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
                    }
                    return null;
                } catch (err) {
                    console.error('Error extracting listing data:', err);
                    return null;
                }
            }));

            // Filter out any null listings and return the results
            const validListings = extractedListings.filter(listing => listing !== null);

            return c.json({
                source: searchUrl,
                timestamp: new Date().toISOString(),
                totalListings: validListings.length,
                listings: validListings
            }, 200, {
                'Content-Type': 'application/json'
            });

        } catch (error) {
            console.error('Error during scraping:', error);
            return c.json({
                error: "Failed to fetch listings",
                message: error instanceof Error ? error.message : String(error)
            }, 500, {
                'Content-Type': 'application/json'
            });
        }

    } catch (error) {
        console.error('Error during scraping:', error);
        return c.json({
            error: "Failed to fetch listings",
            message: error instanceof Error ? error.message : String(error)
        }, 500, {
            'Content-Type': 'application/json'
        });
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

app.post('/api/zipcode', async (c) => {
    try {
        const { city, state } = await c.req.json();
        
        if (!city || !state) {
            return c.json({ error: 'City and state are required' }, 400);
        }

        const messages = [
            { role: "system", content: "You are a helpful assistant that provides zipcodes for US cities. Only respond with the zipcode number, nothing else." },
            {
                role: "user",
                content: `What is the main zipcode for ${city}, ${state}? Only respond with the zipcode number.`,
            },
        ];

        const response = await c.env.AI.run("@cf/meta/llama-4-scout-17b-16e-instruct", { messages });
        
        // Extract the zipcode from the response
        const zipcode = (response as any).response?.trim() || '';
        
        // Validate the zipcode format
        if (!/^\d{5}$/.test(zipcode)) {
            return c.json({ 
                error: 'Could not determine a valid zipcode for the specified city and state. Please try a different city or enter a zipcode directly.' 
            }, 400);
        }

        // Construct the Redfin URL directly with the zipcode
        const searchUrl = `https://www.redfin.com/zipcode/${zipcode}`;
        
        return c.json({ 
            zipcode,
            searchUrl,
            message: `Found zipcode ${zipcode} for ${city}, ${state}`
        });
    } catch (error) {
        console.error('Error getting zipcode:', error);
        return c.json({ 
            error: 'Failed to get zipcode. Please try again or enter a zipcode directly.',
            details: error instanceof Error ? error.message : 'Unknown error'
        }, 500);
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