/*
 * Pekora.zip Account Watcher with User Lookup Proxy
 * 
 * This script continuously monitors the Pekora.zip API for new user accounts
 * and provides a proxy endpoint for user lookups.
 * 
 * INSTALLATION:
 * npm install axios express cors
 * 
 * USAGE:
 * node watcher.js
 * 
 * ENDPOINTS:
 * - GET /latest - Get the latest account
 * - GET /users/:id - Proxy to pekora.zip user lookup
 * - GET /health - Health check
 */

const axios = require('axios');
const express = require('express');
const cors = require('cors');
const fs = require('fs');

// Configuration constants
const API_BASE_URL = 'https://www.pekora.zip/users/';
const CACHE_FILE = 'latest_account_cache.json';
const MIN_ID = 1;
const MAX_ID = 5000000;
const POLLING_INTERVAL = 1000; // 1 second
const IDS_TO_CHECK = 10; // Check next 10 IDs
const REQUEST_TIMEOUT = 5000; // 5 seconds timeout for API requests
const EXPRESS_PORT = process.env.PORT || 5000;

// Global state
let latestAccount = null;
let isSearching = false;

/**
 * Checks if an account exists at the given ID
 * @param {number} id - The account ID to check
 * @returns {Promise<Object|null>} - Returns account data if exists, null otherwise
 */
async function checkAccount(id) {
  try {
    const response = await axios.get(`${API_BASE_URL}${id}`, {
      timeout: REQUEST_TIMEOUT,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; PekoraWatcher/1.0)'
      },
      validateStatus: function (status) {
        return status === 200 || status === 404 || status === 401 || status === 400;
      }
    });

    if (response.status === 200 && response.data) {
      return {
        id: id,
        username: response.data.Username || response.data.username || 'Unknown',
        data: response.data
      };
    }
    return null;
  } catch (error) {
    if (error.response && (error.response.status === 404 || error.response.status === 401 || error.response.status === 400)) {
      return null;
    }
    console.error(`Error checking ID ${id}: ${error.message}`);
    return null;
  }
}

/**
 * Performs binary search to find the latest account ID
 */
async function binarySearchLatest(low, high) {
  console.log('Starting binary search for latest account...');
  let latestFound = low;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    console.log(`Binary search: checking ID ${mid} (range: ${low}-${high})`);

    const account = await checkAccount(mid);

    if (account) {
      latestFound = mid;
      console.log(`✓ Found account at ID ${mid}: ${account.username}`);
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  console.log(`Binary search complete. Latest ID found: ${latestFound}`);
  return latestFound;
}

/**
 * Loads the cached latest account from file
 */
function loadCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const data = fs.readFileSync(CACHE_FILE, 'utf8');
      const cached = JSON.parse(data);
      console.log(`Loaded cached account: ID ${cached.id}, Username: ${cached.username}`);
      return cached;
    }
  } catch (error) {
    console.error(`Error loading cache: ${error.message}`);
  }
  return null;
}

/**
 * Saves the latest account to cache file
 */
function saveCache(account) {
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(account, null, 2), 'utf8');
  } catch (error) {
    console.error(`Error saving cache: ${error.message}`);
  }
}

/**
 * Continuously checks for new accounts after the latest known ID
 */
async function continuousPolling() {
  if (!latestAccount) {
    console.error('No latest account set. Cannot start polling.');
    return;
  }

  console.log(`\nStarting continuous polling from ID ${latestAccount.id + 1}...`);
  console.log(`Checking next ${IDS_TO_CHECK} IDs every ${POLLING_INTERVAL}ms\n`);

  while (true) {
    const startId = latestAccount.id + 1;
    const endId = startId + IDS_TO_CHECK - 1;

    for (let id = startId; id <= endId; id++) {
      const account = await checkAccount(id);

      if (account) {
        console.log(`\n🎉 NEW ACCOUNT FOUND! ID: ${account.id}, Username: ${account.username}`);
        latestAccount = account;
        saveCache(account);
      }
      
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    
    await new Promise(resolve => setTimeout(resolve, POLLING_INTERVAL));
  }
}

/**
 * Initializes the watcher by finding or loading the latest account
 */
async function initializeWatcher() {
  console.log('=== Pekora.zip Account Watcher Started ===\n');

  const cached = loadCache();

  if (cached) {
    console.log('Using cached latest account as starting point.');
    latestAccount = cached;
    
    console.log('Verifying cached account...');
    const verified = await checkAccount(cached.id);
    if (!verified) {
      console.log('Cached account no longer exists. Starting fresh search.');
      latestAccount = null;
    }
  }

  if (!latestAccount) {
    isSearching = true;
    const latestId = await binarySearchLatest(MIN_ID, MAX_ID);
    const account = await checkAccount(latestId);

    if (account) {
      latestAccount = account;
      saveCache(account);
      console.log(`\nInitial latest account: ID ${account.id}, Username: ${account.username}\n`);
    } else {
      console.error('Failed to find any accounts. Will retry...');
      setTimeout(initializeWatcher, 5000);
      return;
    }
    isSearching = false;
  }

  continuousPolling();
}

/**
 * Sets up Express server with API endpoints
 */
function setupExpressServer() {
  const app = express();
  
  // Enable CORS for all routes
  app.use(cors());

  // Endpoint to get the latest account
  app.get('/latest', (req, res) => {
    if (!latestAccount) {
      return res.status(503).json({
        error: 'Watcher is still initializing',
        searching: isSearching
      });
    }

    res.json({
      id: latestAccount.id,
      username: latestAccount.username,
      timestamp: new Date().toISOString()
    });
  });

  // Proxy endpoint for user lookups by ID
  app.get('/users/:id', async (req, res) => {
    const userId = parseInt(req.params.id);

    if (isNaN(userId) || userId < 1) {
      return res.status(400).json({
        error: 'Invalid user ID'
      });
    }

    try {
      const response = await axios.get(`${API_BASE_URL}${userId}`, {
        timeout: REQUEST_TIMEOUT,
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; PekoraWatcher/1.0)'
        },
        validateStatus: function (status) {
          return status === 200 || status === 404 || status === 401 || status === 400;
        }
      });

      if (response.status === 200 && response.data) {
        // Return the data with consistent casing
        return res.json({
          Id: response.data.Id || response.data.id || userId,
          Username: response.data.Username || response.data.username || 'Unknown'
        });
      } else {
        // Account doesn't exist
        return res.status(404).json({
          error: 'Account not found'
        });
      }
    } catch (error) {
      console.error(`Error fetching user ${userId}:`, error.message);
      
      if (error.response && (error.response.status === 404 || error.response.status === 401)) {
        return res.status(404).json({
          error: 'Account not found'
        });
      }
      
      return res.status(500).json({
        error: 'Failed to fetch user data'
      });
    }
  });

  // Search by username endpoint
  app.get('/search/:username', async (req, res) => {
    const username = req.params.username;

    if (!username || username.length < 1) {
      return res.status(400).json({
        error: 'Invalid username'
      });
    }

    try {
      // Try the search endpoint format
      const response = await axios.get(`https://www.pekora.zip/users/get-by-username/${username}`, {
        timeout: REQUEST_TIMEOUT,
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; PekoraWatcher/1.0)'
        },
        validateStatus: function (status) {
          return status === 200 || status === 404 || status === 401 || status === 400;
        }
      });

      if (response.status === 200 && response.data) {
        return res.json({
          Id: response.data.Id || response.data.id,
          Username: response.data.Username || response.data.username
        });
      } else {
        return res.status(404).json({
          error: 'User not found'
        });
      }
    } catch (error) {
      console.error(`Error searching username ${username}:`, error.message);
      
      // Try alternate endpoint format
      try {
        const altResponse = await axios.post('https://www.pekora.zip/api/users/search', {
          username: username
        }, {
          timeout: REQUEST_TIMEOUT,
          headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; PekoraWatcher/1.0)',
            'Content-Type': 'application/json'
          },
          validateStatus: function (status) {
            return status === 200 || status === 404 || status === 401 || status === 400;
          }
        });

        if (altResponse.status === 200 && altResponse.data) {
          return res.json({
            Id: altResponse.data.Id || altResponse.data.id,
            Username: altResponse.data.Username || altResponse.data.username
          });
        }
      } catch (altError) {
        console.error(`Alternate search failed:`, altError.message);
      }
      
      // Username search not supported
      return res.status(501).json({
        error: 'Username search not currently supported. Please search by ID instead.'
      });
    }
  });

  // Health check endpoint
  app.get('/health', (req, res) => {
    res.json({
      status: 'running',
      latestAccountId: latestAccount ? latestAccount.id : null,
      searching: isSearching
    });
  });

  // Root endpoint with instructions
  app.get('/', (req, res) => {
    res.json({
      name: 'Pekora.zip Account Watcher',
      endpoints: {
        '/latest': 'Get the latest account information',
        '/users/:id': 'Get user information by ID (proxy to pekora.zip)',
        '/health': 'Check watcher status'
      },
      currentLatest: latestAccount ? {
        id: latestAccount.id,
        username: latestAccount.username
      } : 'Initializing...'
    });
  });

  app.listen(EXPRESS_PORT, '0.0.0.0', () => {
    console.log(`Express API server listening on http://0.0.0.0:${EXPRESS_PORT}`);
    console.log(`Endpoints available:`);
    console.log(`  - GET /latest - Get latest account`);
    console.log(`  - GET /users/:id - Lookup user by ID`);
    console.log(`  - GET /health - Health check\n`);
  });
}

/**
 * Main entry point
 */
async function main() {
  setupExpressServer();

  try {
    await initializeWatcher();
  } catch (error) {
    console.error('Fatal error in watcher:', error);
    setTimeout(main, 10000);
  }
}

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('\n\nShutting down gracefully...');
  if (latestAccount) {
    saveCache(latestAccount);
    console.log('Latest account saved to cache.');
  }
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n\nShutting down gracefully...');
  if (latestAccount) {
    saveCache(latestAccount);
    console.log('Latest account saved to cache.');
  }
  process.exit(0);
});

// Start the application
main();
