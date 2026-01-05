const https = require('https');
const http = require('http');
const { URL } = require('url');

// In-memory cache for JWT tokens
const tokenCache = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Fetches a JWT token from the Auth Hub for a given shop ID.
 * Implements in-memory caching with 5-minute TTL.
 *
 * @param {string} shopId - The shop ID to get a token for
 * @returns {Promise<string>} - The JWT token
 * @throws {Error} - If the request fails or token is not returned
 */
async function getJWTToken(shopId) {
  if (!shopId) {
    throw new Error('shopId is required');
  }

  // Check cache first
  const cached = tokenCache.get(shopId);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.token;
  }

  // Remove expired entry if exists
  if (cached) {
    tokenCache.delete(shopId);
  }

  const authHubUrl = process.env.AUTH_HUB_URL || 'https://wiorzvaptjwasczzahxm.supabase.co/functions/v1';
  const appKey = process.env.AUTH_HUB_APP_KEY;

  if (!appKey) {
    throw new Error('AUTH_HUB_APP_KEY environment variable is not set');
  }

  const url = `${authHubUrl}/token/${encodeURIComponent(shopId)}`;

  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const protocol = parsedUrl.protocol === 'https:' ? https : http;

    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'GET',
      headers: {
        'x-app-key': appKey,
        'Accept': 'application/json'
      }
    };

    const req = protocol.request(options, (res) => {
      let data = '';

      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {
        try {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`Auth Hub request failed with status ${res.statusCode}: ${data}`));
            return;
          }

          const response = JSON.parse(data);

          if (!response.jwt_token) {
            reject(new Error('jwt_token not found in Auth Hub response'));
            return;
          }

          // Cache the token
          tokenCache.set(shopId, {
            token: response.jwt_token,
            expiresAt: Date.now() + CACHE_TTL_MS
          });

          resolve(response.jwt_token);
        } catch (parseError) {
          reject(new Error(`Failed to parse Auth Hub response: ${parseError.message}`));
        }
      });
    });

    req.on('error', (error) => {
      reject(new Error(`Auth Hub request failed: ${error.message}`));
    });

    req.setTimeout(30000, () => {
      req.destroy();
      reject(new Error('Auth Hub request timed out'));
    });

    req.end();
  });
}

/**
 * Clears the token cache. Useful for testing or forcing token refresh.
 * @param {string} [shopId] - Optional shop ID to clear. If not provided, clears all cached tokens.
 */
function clearCache(shopId) {
  if (shopId) {
    tokenCache.delete(shopId);
  } else {
    tokenCache.clear();
  }
}

module.exports = {
  getJWTToken,
  clearCache
};
