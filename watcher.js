/*
 * Pekora.zip Account Watcher
 * 
 * This script continuously monitors the Pekora.zip API for new user accounts.
 * 
 * INSTALLATION:
 * npm install axios express
 * 
 * USAGE:
 * node watcher.js
 * 
 * FEATURES:
 * - Binary search to find the latest account ID (1 to 5,000,000)
 * - Continuous polling for new accounts (checks next 10 IDs every second)
 * - Persistent caching in latest_account_cache.json
 * - Express API endpoint at /latest to retrieve current latest account
 * - Graceful error handling and automatic retries
 */

const axios = require('axios');
const express = require('express');
const fs = require('fs');
const path = require('path');

// Configuration constants
const API_BASE_URL = 'https://www.pekora.zip/users/';
const CACHE_FILE = 'latest_account_cache.json';
const MIN_ID = 1;
const MAX_ID = 5000000;
const POLLING_INTERVAL = 1000; // 1 second
const IDS_TO_CHECK = 10; // Check next 10 IDs
const REQUEST_TIMEOUT = 5000; // 5 seconds timeout for API requests
const EXPRESS_PORT = 5000;

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
    // Log network errors but don't crash
    console.error(`Error checking ID ${id}: ${error.message}`);
    return null;
  }
}

/**
 * Performs binary search to find the latest account ID
 * @param {number} low - Lower bound of search range
 * @param {number} high - Upper bound of search range
 * @returns {Promise<number>} - The latest account ID found
 */
async function binarySearchLatest(low, high) {
  console.log('Starting binary search for latest account...');
  let latestFound = low;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    console.log(`Binary search: checking ID ${mid} (range: ${low}-${high})`);

    const account = await checkAccount(mid);

    if (account) {
      // Account exists, search higher
      latestFound = mid;
      console.log(`✓ Found account at ID ${mid}: ${account.username}`);
      low = mid + 1;
    } else {
      // Account doesn't exist, search lower
      high = mid - 1;
    }
  }

  console.log(`Binary search complete. Latest ID found: ${latestFound}`);
  return latestFound;
}

/**
 * Loads the cached latest account from file
 * @returns {Object|null} - Cached account data or null if not found
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
 * @param {Object} account - Account data to save
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

  // Use async while loop instead of setInterval to prevent overlapping requests
  while (true) {
    // Check the next 10 IDs after the current latest
    const startId = latestAccount.id + 1;
    const endId = startId + IDS_TO_CHECK - 1;

    for (let id = startId; id <= endId; id++) {
      const account = await checkAccount(id);

      if (account) {
        // New account found!
        console.log(`\n🎉 NEW ACCOUNT FOUND! ID: ${account.id}, Username: ${account.username}`);
        latestAccount = account;
        saveCache(account);
      }
      
      // Add a small delay between requests to avoid rate limiting (100ms per request)
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    
    // Wait for the polling interval before the next batch
    await new Promise(resolve => setTimeout(resolve, POLLING_INTERVAL));
  }
}

/**
 * Initializes the watcher by finding or loading the latest account
 */
async function initializeWatcher() {
  console.log('=== Pekora.zip Account Watcher Started ===\n');

  // Try to load from cache first
  const cached = loadCache();

  if (cached) {
    console.log('Using cached latest account as starting point.');
    latestAccount = cached;
    
    // Verify the cached account still exists
    console.log('Verifying cached account...');
    const verified = await checkAccount(cached.id);
    if (!verified) {
      console.log('Cached account no longer exists. Starting fresh search.');
      latestAccount = null;
    }
  }

  // If no cache or verification failed, do binary search
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
      // Retry after a delay
      setTimeout(initializeWatcher, 5000);
      return;
    }
    isSearching = false;
  }

  // Start continuous polling
  continuousPolling();
}

/**
 * Sets up Express server with API endpoint
 */
function setupExpressServer() {
  const app = express();

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
    console.log(`Access /latest endpoint to get current latest account\n`);
  });
}

/**
 * Main entry point
 */
async function main() {
  // Set up the Express server first
  setupExpressServer();

  // Initialize the watcher and start monitoring
  try {
    await initializeWatcher();
  } catch (error) {
    console.error('Fatal error in watcher:', error);
    // Retry initialization after a delay
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
