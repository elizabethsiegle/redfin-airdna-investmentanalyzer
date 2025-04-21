import puppeteer, { Page } from "@cloudflare/puppeteer";
import { Hono } from 'hono';
import { serveStatic } from '@hono/node-server/serve-static'

export interface Env {
  MYBROWSER: any; // Browser binding for Cloudflare's Browser Rendering API
  BROWSER_KV_LV_HX: KVNamespace; // KV namespace for caching
  AI: Ai;
  [key: string]: any;
  AIRDNA_EMAIL: string; // Add to your Cloudflare env vars
  AIRDNA_PASSWORD: string; // Add to your Cloudflare env vars
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
  airDnaData?: {
    estimatedRent: number;
    occupancyRate: number;
    revenuePotential: number;
  };
}


async function loginToAirDna(page: Page, env: Env): Promise<boolean> {
  try {
    // Navigate to AirDNA login page
    await page.goto('https://auth.airdna.co/oauth2/authorize?tenantId=1fb206a8-177b-4684-af1f-8fff7cc153a0&client_id=5f040464-0aef-48a1-a1d1-daa9fbf81415&nonce=&pendingIdPLinkId=&redirect_uri=https%3A%2F%2Fapp.airdna.co&response_mode=&response_type=code&scope=profile%20openid&state=%7B%22path%22%3A%22%2Fdata%22%2C%22search%22%3A%22%22%7D&timezone=&metaData.device.name=&metaData.device.type=&code_challenge=&code_challenge_method=&user_code=', {
      waitUntil: 'networkidle0',
      timeout: 30000
    });

    // Wait for the page to be fully loaded
    await page.waitForFunction(() => document.readyState === 'complete', { timeout: 10000 });

    // Check if we're already logged in
    const accountMenu = await page.$('button[aria-label="Account menu"]');
    if (accountMenu) {
      console.log('Already logged in');
      return true;
    }

    // Wait for the login form to be visible
    await page.waitForSelector('form', { timeout: 10000 });
    
    // Wait for the email input to be visible and interactable
    await page.waitForSelector('#loginId', { 
      visible: true,
      timeout: 10000 
    });
    
    // Wait for the password input to be visible and interactable
    await page.waitForSelector('#password', { 
      visible: true,
      timeout: 10000 
    });
    
    // Fill in credentials with a delay between each character
    await page.type('#loginId', env.AIRDNA_EMAIL, { delay: 50 });
    await page.type('#password', env.AIRDNA_PASSWORD, { delay: 50 });
    
    // Click the login button
    const loginButton = await page.waitForSelector('#submit-button', { 
      visible: true,
      timeout: 10000 
    });
    if (!loginButton) {
      throw new Error('Login button not found');
    }
    
    // Click the button and wait for navigation
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 30000 }),
      loginButton.click()
    ]);
  
    
    return true;
  } catch (error) {
    console.error('Error logging into AirDNA:', error);
    // Take a screenshot for debugging
    await page.screenshot({ path: 'login-error.png' }).catch(() => {});
    return false;
  }
}

async function getAirDnaData(page: Page, address: string, beds: number): Promise<any> {
  try {
    // Navigate to rentalizer with the address
    const rentalizerUrl = `https://app.airdna.co/data/rentalizer?address=${encodeURIComponent(address)}&bedrooms=${beds}&bathrooms=2&accommodates=4`;
    await page.goto(rentalizerUrl, {
      waitUntil: 'networkidle0',
      timeout: 30000
    });

    // Wait for the page to load
    await page.waitForSelector('h3.MuiTypography-root.MuiTypography-titleM.css-sd2qa2', { timeout: 15000 });

    // Extract all data using the provided selectors
    const data = await page.evaluate(() => {
      // Helper function to extract numeric value from text
      const extractNumber = (text: string | null): number => {
        if (!text) return 0;
        // Remove $, K, and any other non-numeric characters except decimal point
        const cleaned = text.replace(/[^0-9.]/g, '');
        // If the original text had 'K', multiply by 1000
        const multiplier = text.includes('K') ? 1000 : 1;
        return parseFloat(cleaned) * multiplier;
      };

      // Get net operating income
      const noiElement = document.querySelector('h3.MuiTypography-root.MuiTypography-titleM.css-sd2qa2');
      const netOperatingIncome = extractNumber(noiElement?.textContent || '');

      // Get occupancy rate
      const occupancyElement = document.querySelector('p.MuiTypography-root.MuiTypography-body1.css-kk2mec');
      const occupancyText = occupancyElement?.textContent || '';
      const occupancyRate = parseFloat(occupancyText.replace(/[^0-9.]/g, '')) || 0;

      return {
        netOperatingIncome,
        occupancyRate
      };
    });

    return data;
  } catch (error) {
    console.error('Error getting AirDNA data:', error);
    return null;
  }
}

async function extractListingsWithAirDna(page: Page, env: Env): Promise<Listing[]> {
  const listings = await extractListings(page);
  
  // Launch a new browser for AirDNA to avoid conflicts
  const airDnaBrowser = await puppeteer.launch(env.MYBROWSER);
  const airDnaPage = await airDnaBrowser.newPage();
  
  try {
    // Login to AirDNA
    const loggedIn = await loginToAirDna(airDnaPage, env);
    if (!loggedIn) {
      console.log('Failed to login to AirDNA, skipping rental data');
      return listings;
    }

    // Get AirDNA data for each listing
    for (const listing of listings) {
      try {
        const airDnaData = await getAirDnaData(airDnaPage, listing.address, listing.beds);
        if (airDnaData) {
          listing.airDnaData = airDnaData;
        }
      } catch (error) {
        console.error(`Error getting AirDNA data for ${listing.address}:`, error);
      }
    }
  } finally {
    await airDnaBrowser.close();
  }

  return listings;
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

        // Validate required parameters
        if (!zip && (!city || !state)) {
            return c.json({ 
                error: 'Either zipcode or city and state are required',
                status: 400
            }, 400);
        }

        let searchZipcode = '';  // Initialize with empty string

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
                    error: 'Could not determine a valid zipcode for the specified city and state. Please try a different city or enter a zipcode directly.',
                    status: 400
                }, 400);
            }
        }

        // Construct the search URL with the zipcode
        let searchUrl = `https://www.redfin.com/zipcode/${searchZipcode}`;

        // Add filters to the URL
        const filters = [];
        if (minPrice > 0) filters.push(`min-price=${Math.floor(minPrice/1000)}k`);
        if (maxPrice > 0) filters.push(`max-price=${Math.floor(maxPrice/1000)}k`);
        if (minBeds > 0) filters.push(`min-beds=${minBeds}`);
        if (features.length > 0) filters.push(`remarks=${features.join(',')}`);
        if (maxHOA < 10000) filters.push(`hoa=${maxHOA}`);

        // Add filters to URL if they exist
        if (filters.length > 0) {
            searchUrl += `/filter/${filters.join(',')}`;
        }

        console.log('Searching with URL:', searchUrl);

        // Initialize browser with increased timeout
        browser = await puppeteer.launch(c.env.MYBROWSER);
        const page = await browser.newPage();
        
        // Set a more realistic user agent
        await page.setUserAgent(
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36"
        );

        // Add additional headers to appear more like a real browser
        await page.setExtraHTTPHeaders({
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
            'Accept-Encoding': 'gzip, deflate, br',
            'Connection': 'keep-alive',
            'Upgrade-Insecure-Requests': '1'
        });

        // Set default navigation timeout
        page.setDefaultNavigationTimeout(60000); // 60 seconds

        // Navigate to the search URL with retry logic and random delay
        let retryCount = 0;
        const maxRetries = 3;
        
        while (retryCount < maxRetries) {
            try {
                // Add a random delay between 1-3 seconds before each attempt
                await new Promise(resolve => setTimeout(resolve, 1000 + Math.random() * 2000));
                
                await page.goto(searchUrl, {
                    waitUntil: 'networkidle0',
                    timeout: 60000
                });

                // Check if we got redirected to a captcha or error page
                const currentUrl = page.url();
                if (currentUrl.includes('captcha') || currentUrl.includes('error')) {
                    throw new Error('Detected captcha or error page');
                }

                break; // If successful, break the retry loop
            } catch (error) {
                retryCount++;
                if (retryCount === maxRetries) {
                    throw error;
                }
                console.log(`Navigation attempt ${retryCount} failed, retrying...`);
                await new Promise(resolve => setTimeout(resolve, 2000));
            }
        }

        // Wait for either listings or no results message with increased timeout
        try {
            await Promise.race([
                page.waitForSelector('.HomeCardContainer', { timeout: 30000 }),
                page.waitForSelector('.no-results-message', { timeout: 30000 })
            ]);

            // Check if we have a "no results" message
            const noResults = await page.$('.no-results-message');
            if (noResults) {
                return c.json({
                    source: searchUrl,
                    timestamp: new Date().toISOString(),
                    totalListings: 0,
                    listings: [],
                    message: 'No listings found matching your criteria',
                    status: 200
                });
            }

            // Extract listings data
            const listings = await extractListings(page);
            
            if (listings.length === 0) {
                return c.json({
                    source: searchUrl,
                    timestamp: new Date().toISOString(),
                    totalListings: 0,
                    listings: [],
                    message: 'No listings found matching your criteria',
                    status: 200
                });
            }

            return c.json({
                source: searchUrl,
                timestamp: new Date().toISOString(),
                totalListings: listings.length,
                listings: listings,
                status: 200
            });

        } catch (error) {
            console.error('Error during scraping:', error);
            return c.json({
                error: "Failed to fetch listings",
                message: "The request timed out. Please try again or refine your search criteria.",
                status: 500
            }, 500);
        }

    } catch (error) {
        console.error('Error during scraping:', error);
        return c.json({
            error: "Failed to fetch listings",
            message: error instanceof Error ? error.message : "An unexpected error occurred. Please try again.",
            status: 500
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
app.get('/api/financials', async (c) => {
    try {
        // Get query parameters
        const address = c.req.query('address');
        if (!address) {
            return c.json({ 
                error: 'Address is required',
                status: 400
            }, 400);
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

            // First, login to AirDNA
            const loggedIn = await loginToAirDna(page, c.env);
            if (!loggedIn) {
                return c.json({
                    status: 'error',
                    error: 'Failed to login to AirDNA',
                    message: 'Could not authenticate with AirDNA'
                }, 401);
            }

            // Navigate to AirDNA rentalizer
            const url = `https://app.airdna.co/data/rentalizer?address=${encodeURIComponent(address)}&bedrooms=2&bathrooms=2&accommodates=4`;
            await page.goto(url, {
                waitUntil: 'networkidle0',
                timeout: 30000
            });

            // Wait for the page to load
            await page.waitForSelector('h3', { timeout: 15000 });

            // Extract all data using XPath
            const data = await page.evaluate(() => {
                const getValue = (xpath: string) => {
                    const result = document.evaluate(
                        xpath,
                        document,
                        null,
                        XPathResult.FIRST_ORDERED_NODE_TYPE,
                        null
                    );
                    const element = result.singleNodeValue;
                    return element ? parseFloat(element.textContent?.replace(/[^0-9.]/g, '') || '0') : 0;
                };

                return {
                    estimatedRent: getValue('/html/body/div[2]/div/main/div/div/div[2]/div[1]/div[2]/div[2]/div/div[2]/div[2]/div[2]/h3'),
                    occupancyRate: getValue('/html/body/div[2]/div/main/div/div/div[2]/div[1]/div[2]/div[2]/div/div[2]/div[3]/div[2]/h3'),
                    revenuePotential: getValue('/html/body/div[2]/div/main/div/div/div[2]/div[1]/div[2]/div[2]/div/div[2]/div[4]/div[2]/h3')
                };
            });

            if (!data.estimatedRent && !data.occupancyRate && !data.revenuePotential) {
                return c.json({
                    status: 'error',
                    error: 'No data found',
                    message: 'Could not find rental data for this property'
                }, 404);
            }

            return c.json({
                status: 'success',
                data
            });

        } catch (error) {
            console.error('Error fetching financial data:', error);
            return c.json({
                status: 'error',
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
    } catch (error) {
        console.error('Error in financials endpoint:', error);
        return c.json({
            status: 'error',
            error: 'Internal server error',
            message: error instanceof Error ? error.message : String(error)
        }, 500);
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

app.get('/listings/financials', async (c) => {
    try {
        // TODO: Implement financial data fetching logic
        return c.json({
            status: 'success',
            message: 'Financial data endpoint is ready',
            data: {
                // Placeholder data structure
                estimatedRent: 0,
                occupancyRate: 0,
                revenuePotential: 0
            }
        });
    } catch (error) {
        console.error('Error fetching financial data:', error);
        return c.json({
            status: 'error',
            message: 'Failed to fetch financial data',
            error: error instanceof Error ? error.message : 'Unknown error'
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