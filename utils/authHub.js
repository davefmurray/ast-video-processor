const https = require('https');
const http = require('http');
const { URL } = require('url');

// In-memory cache for JWT tokens
const tokenCache = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes cache TTL
const TOKEN_EXPIRY_BUFFER_MS = 5 * 60 * 1000; // 5 minute buffer before actual expiry

/**
 * Checks if a cached token is still valid based on actual Tekmetric expiry.
 * Returns false if token is expired or will expire within the buffer window.
 * @param {Object} cached - The cached token entry
 * @returns {boolean} - True if token is still valid
 */
function isTokenValid(cached) {
  if (!cached) return false;

  const now = Date.now();

  // Check cache TTL
  if (now >= cached.cacheExpiresAt) return false;

  // Check actual Tekmetric token expiry if available
  if (cached.tokenExpiresAt) {
    const expiryTime = new Date(cached.tokenExpiresAt).getTime();
    // Return invalid if token will expire within buffer window
    if (now >= expiryTime - TOKEN_EXPIRY_BUFFER_MS) return false;
  }

  return true;
}

/**
 * Fetches a JWT token from the Auth Hub for a given shop ID.
 * Implements in-memory caching with 5-minute TTL and checks actual token expiry.
 *
 * @param {string} shopId - The shop ID to get a token for
 * @returns {Promise<string>} - The JWT token
 * @throws {Error} - If the request fails or token is not returned
 */
async function getJWTToken(shopId) {
  if (!shopId) {
    throw new Error('shopId is required');
  }

  // Check cache first - validate against both cache TTL and actual token expiry
  const cached = tokenCache.get(shopId);
  if (isTokenValid(cached)) {
    return cached.token;
  }

  // Remove invalid/expired entry if exists
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

          // Cache the token with both cache TTL and actual token expiry
          tokenCache.set(shopId, {
            token: response.jwt_token,
            cacheExpiresAt: Date.now() + CACHE_TTL_MS,
            tokenExpiresAt: response.token_expires_at || null // Actual Tekmetric token expiry
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
