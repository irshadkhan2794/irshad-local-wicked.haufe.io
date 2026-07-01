#!/usr/bin/env node

/**
 * Standalone script to sync businessSegment/productGroup tags from apis.json
 * to all corresponding Kong services.
 *
 * Usage:
 *   KONG_ADMIN_URL=http://<kong-admin>:8001 \
 *   APIS_JSON_PATH=/opt/reuters/data/wicked-config/dev-snapshot/static/apis/apis.json \
 *   node sync-kong-tags.js
 *
 * Options (env vars):
 *   KONG_ADMIN_URL   - Kong Admin API base URL (default: http://localhost:8001)
 *   APIS_JSON_PATH   - Path to apis.json file (required)
 *   DRY_RUN          - Set to "true" to only print what would be done
 */

'use strict';

const fs = require('fs');
const http = require('http');
const https = require('https');
const url = require('url');

const KONG_ADMIN_URL = process.env.KONG_ADMIN_URL || 'http://localhost:8001';
const APIS_JSON_PATH = process.env.APIS_JSON_PATH || '/opt/reuters/data/wicked-config/dev-snapshot/static/apis/apis.json';
const DRY_RUN = process.env.DRY_RUN === 'true' ;

if (!APIS_JSON_PATH) {
    console.error('ERROR: APIS_JSON_PATH environment variable is required.');
    console.error('Example: APIS_JSON_PATH=/opt/reuters/data/wicked-config/dev-snapshot/static/apis/apis.json');
    process.exit(1);
}

// --- Helpers ---

function buildServiceTags(api) {
    const tags = [];
    if (api.businessSegment) {
        tags.push('business_segment:' + api.businessSegment);
    }
    if (api.productGroup) {
        tags.push('product_group:' + api.productGroup);
    }
    return tags.length > 0 ? tags : [];
}

function kongRequest(method, path, body) {
    return new Promise((resolve, reject) => {
        const parsed = new URL(path, KONG_ADMIN_URL);
        const options = {
            hostname: parsed.hostname,
            port: parsed.port,
            path: parsed.pathname + parsed.search,
            method: method,
            headers: {
                'Content-Type': 'application/json',
                'X-ApiKey': process.env.KONG_ADMIN_API_KEY || '',
            },
            timeout: 10000,
        };

        const lib = parsed.protocol === 'https:' ? https : http;
        const req = lib.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    try {
                        resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null });
                    } catch (e) {
                        resolve({ status: res.statusCode, body: data });
                    }
                } else {
                    reject({ status: res.statusCode, body: data, path: path });
                }
            });
        });

        req.on('error', (err) => reject(err));
        req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });

        if (body) {
            req.write(JSON.stringify(body));
        }
        req.end();
    });
}

// --- Main ---

async function main() {
    // 1. Read apis.json
    console.log('Reading apis.json from:', APIS_JSON_PATH);
    const raw = fs.readFileSync(APIS_JSON_PATH, 'utf8');
    const apisConfig = JSON.parse(raw);
    const portalApis = apisConfig.apis;
    console.log('Found', portalApis.length, 'APIs in portal config.\n');

    let updated = 0;
    let skipped = 0;
    let notFound = 0;
    let errors = 0;

    for (const api of portalApis) {
        const serviceName = api.id;
        const tags = buildServiceTags(api);

        if (tags.length === 0) {
            console.log(`  [SKIP] ${serviceName} - no businessSegment/productGroup`);
            skipped++;
            continue;
        }

        // 2. Get current Kong service
        let kongService;
        try {
            const result = await kongRequest('GET', '/admin/api/services/' + encodeURIComponent(serviceName));
            kongService = result.body;
        } catch (err) {
            if (err && err.status === 404) {
                console.log(`  [NOT FOUND] ${serviceName} - not in Kong, skipping`);
                notFound++;
                continue;
            }
            console.error(`  [ERROR] ${serviceName} - failed to GET:`, err.body || err.message || err);
            errors++;
            continue;
        }

        // 3. Merge tags: preserve existing tags that are NOT business_segment/product_group
        const existingTags = kongService.tags || [];
        const preservedTags = existingTags.filter(tag =>
            !tag.startsWith('business_segment:') && !tag.startsWith('product_group:')
        );
        const mergedTags = [...preservedTags, ...tags];

        // Check if tags already match (no change needed)
        const tagsMatch = JSON.stringify(existingTags.sort()) === JSON.stringify(mergedTags.sort());

        if (tagsMatch) {
            console.log(`  [OK] ${serviceName} - tags already match: [${existingTags.join(', ')}]`);
            skipped++;
            continue;
        }

        // 4. Patch ONLY the tags field - no other service config is affected
        if (DRY_RUN) {
            console.log(`  [DRY RUN] ${serviceName} - would patch tags: [${mergedTags.join(', ')}] (current: [${existingTags.join(', ')}])`);
            updated++;
            continue;
        }

        try {
            await kongRequest('PATCH', '/admin/api/services/' + encodeURIComponent(serviceName), { tags: mergedTags });
            console.log(`  [UPDATED] ${serviceName} - tags set to: [${mergedTags.join(', ')}]`);
            updated++;
        } catch (err) {
            console.error(`  [ERROR] ${serviceName} - failed to PATCH:`, err.body || err.message || err);
            errors++;
        }
    }

    // Summary
    console.log('\n--- Summary ---');
    console.log('Total APIs in portal:', portalApis.length);
    console.log('Updated:', updated);
    console.log('Skipped (already OK or no tags):', skipped);
    console.log('Not found in Kong:', notFound);
    console.log('Errors:', errors);

    if (errors > 0) {
        process.exit(1);
    }
}

main().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
});
