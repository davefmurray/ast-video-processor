/**
 * Video Processing Routes
 * Handles video merge and upload operations using FFmpeg
 */

const express = require('express');
const router = express.Router();
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const https = require('https');
const Busboy = require('busboy');
const { getJWTToken } = require('../utils/authHub');

// Environment config
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const AUTH_HUB_URL = process.env.AUTH_HUB_URL || 'https://auth-hub.automotiveservicetech.com';
const TM_API_BASE = process.env.TM_API_BASE || 'https://shop.tekmetric.com';

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Download file from URL to local path
 * Handles redirects (301, 302)
 */
function downloadFile(fileUrl, destPath) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(fileUrl);
    const protocol = urlObj.protocol === 'https:' ? https : http;
    const file = fs.createWriteStream(destPath);

    protocol.get(fileUrl, (response) => {
      if (response.statusCode === 301 || response.statusCode === 302) {
        file.close();
        fs.unlinkSync(destPath);
        return downloadFile(response.headers.location, destPath).then(resolve).catch(reject);
      }
      if (response.statusCode !== 200) {
        file.close();
        fs.unlinkSync(destPath);
        return reject(new Error(`Download failed: ${response.statusCode}`));
      }
      response.pipe(file);
      file.on('finish', () => { file.close(); resolve(destPath); });
    }).on('error', (err) => {
      file.close();
      fs.unlink(destPath, () => {});
      reject(err);
    });
  });
}

/**
 * Run FFmpeg command and return promise
 * Logs progress during encoding
 */
function runFFmpeg(args) {
  return new Promise((resolve, reject) => {
    console.log(`   Running: ffmpeg ${args.slice(0, 5).join(' ')}...`);
    const ffmpeg = spawn('ffmpeg', args);
    let stderr = '';

    ffmpeg.stderr.on('data', (data) => {
      stderr += data.toString();
      const timeMatch = data.toString().match(/time=(\d+:\d+:\d+\.\d+)/);
      if (timeMatch) console.log(`   Progress: ${timeMatch[1]}`);
    });

    ffmpeg.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`FFmpeg failed (code ${code}): ${stderr.slice(-200)}`));
    });

    ffmpeg.on('error', reject);
  });
}

/**
 * Merge two videos with FFmpeg (3-pass for compatibility)
 * Pass 1: Normalize issue video to intermediate format (MPEG-TS)
 * Pass 2: Normalize explainer video to intermediate format
 * Pass 3: Concatenate the two normalized videos
 */
async function mergeVideos(issueVideoPath, explainerVideoPath, outputPath) {
  console.log('[video] Starting FFmpeg merge...');
  console.log(`   Issue video: ${issueVideoPath}`);
  console.log(`   Explainer: ${explainerVideoPath}`);

  const tempVideo1 = path.join(os.tmpdir(), `temp1-${Date.now()}.ts`);
  const tempVideo2 = path.join(os.tmpdir(), `temp2-${Date.now()}.ts`);

  try {
    // Step 1: Convert issue video to intermediate format (MPEG-TS)
    console.log('   Step 1/3: Converting issue video...');
    await runFFmpeg([
      '-y', '-i', issueVideoPath,
      '-vf', 'scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1',
      '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
      '-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-ac', '2',
      '-bsf:v', 'h264_mp4toannexb',
      '-f', 'mpegts', tempVideo1
    ]);

    // Step 2: Convert explainer video to intermediate format
    console.log('   Step 2/3: Converting explainer video...');
    await runFFmpeg([
      '-y', '-i', explainerVideoPath,
      '-vf', 'scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1',
      '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
      '-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-ac', '2',
      '-bsf:v', 'h264_mp4toannexb',
      '-f', 'mpegts', tempVideo2
    ]);

    // Step 3: Concat the two normalized videos
    console.log('   Step 3/3: Concatenating...');
    await runFFmpeg([
      '-y',
      '-i', `concat:${tempVideo1}|${tempVideo2}`,
      '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
      '-c:a', 'aac', '-b:a', '128k',
      '-movflags', '+faststart',
      outputPath
    ]);

    console.log('[video] FFmpeg merge complete!');
    return outputPath;

  } finally {
    // Cleanup temp files
    try { fs.unlinkSync(tempVideo1); } catch(e) {}
    try { fs.unlinkSync(tempVideo2); } catch(e) {}
  }
}

/**
 * Parse multipart form data using busboy
 * Extracts fields and video file
 */
function parseMultipart(req) {
  return new Promise((resolve, reject) => {
    const fields = {};
    let videoFile = null;

    const busboy = Busboy({ headers: req.headers });

    busboy.on('field', (name, value) => { fields[name] = value; });

    busboy.on('file', (name, file, info) => {
      if (name === 'videoFile') {
        const videoPath = path.join(os.tmpdir(), `upload-${Date.now()}-${info.filename || 'video.mp4'}`);
        const writeStream = fs.createWriteStream(videoPath);
        file.pipe(writeStream);
        writeStream.on('finish', () => {
          videoFile = { path: videoPath, filename: info.filename, mimeType: info.mimeType };
        });
      } else {
        file.resume();
      }
    });

    busboy.on('finish', () => {
      // Small delay to ensure writeStream finish event fires first
      setTimeout(() => resolve({ fields, videoFile }), 100);
    });

    busboy.on('error', reject);
    req.pipe(busboy);
  });
}

/**
 * Get explainer video URL from Supabase
 */
async function getExplainerVideoUrl(explainerId) {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    console.log('[video] Supabase not configured');
    return null;
  }

  try {
    const url = new URL('/rest/v1/explainer_videos', SUPABASE_URL);
    url.searchParams.set('id', `eq.${explainerId}`);
    url.searchParams.set('select', 'file_url,name');

    const response = await new Promise((resolve, reject) => {
      const req = https.request(url, {
        method: 'GET',
        headers: {
          'apikey': SUPABASE_ANON_KEY,
          'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
          'Content-Type': 'application/json'
        }
      }, resolve);
      req.on('error', reject);
      req.end();
    });

    let data = '';
    response.on('data', chunk => data += chunk);
    await new Promise((resolve) => response.on('end', resolve));

    const videos = JSON.parse(data);
    return videos && videos.length > 0 ? videos[0] : null;
  } catch (error) {
    console.error('[video] Error fetching explainer:', error.message);
    return null;
  }
}

/**
 * Upload file to S3 via multipart form POST
 */
function uploadToS3Form(s3Url, s3Fields, s3Key, filePath, contentType) {
  return new Promise((resolve, reject) => {
    const fileSize = fs.statSync(filePath).size;
    const boundary = `----FormBoundary${Date.now()}`;
    const urlObj = new URL(s3Url);

    console.log(`[video] Uploading ${(fileSize / 1024 / 1024).toFixed(2)} MB to S3...`);

    // Build multipart form data manually
    let formParts = [];

    // Add all S3 signature fields first
    for (const [key, value] of Object.entries(s3Fields)) {
      formParts.push(`--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`);
    }

    // Add key
    formParts.push(`--${boundary}\r\nContent-Disposition: form-data; name="key"\r\n\r\n${s3Key}\r\n`);

    // Add content-type
    formParts.push(`--${boundary}\r\nContent-Disposition: form-data; name="Content-Type"\r\n\r\n${contentType}\r\n`);

    // File header (file content added separately)
    const fileHeader = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="video.mp4"\r\nContent-Type: ${contentType}\r\n\r\n`;
    const fileFooter = `\r\n--${boundary}--\r\n`;

    const preFileBuffer = Buffer.from(formParts.join('') + fileHeader);
    const postFileBuffer = Buffer.from(fileFooter);
    const totalLength = preFileBuffer.length + fileSize + postFileBuffer.length;

    const req = https.request({
      hostname: urlObj.hostname,
      port: 443,
      path: urlObj.pathname,
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': totalLength
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 204 || res.statusCode === 200 || res.statusCode === 201) {
          console.log('[video] S3 upload complete!');
          resolve({ success: true });
        } else {
          reject(new Error(`S3 upload failed: ${res.statusCode} - ${data}`));
        }
      });
    });

    req.on('error', reject);

    // Write form data before file
    req.write(preFileBuffer);

    // Stream file content
    const fileStream = fs.createReadStream(filePath);
    fileStream.on('data', chunk => req.write(chunk));
    fileStream.on('end', () => {
      req.write(postFileBuffer);
      req.end();
    });
    fileStream.on('error', reject);
  });
}

/**
 * Make HTTP/HTTPS request (proxy to TekMetric API)
 * Uses x-auth-token header as required by TM API
 */
function proxyToTM(endpoint, method, body, jwtToken) {
  return new Promise((resolve, reject) => {
    const url = new URL(endpoint, TM_API_BASE);
    const isHttps = url.protocol === 'https:';
    const transport = isHttps ? https : http;

    const options = {
      hostname: url.hostname,
      port: isHttps ? 443 : 80,
      path: url.pathname + url.search,
      method: method,
      headers: {
        'Content-Type': 'application/json',
        'x-auth-token': jwtToken,
        'accept': 'application/json'
      }
    };

    const req = transport.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });

    req.on('error', reject);
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

// getJWTToken is imported from ../utils/authHub.js

// ============================================================================
// Routes
// ============================================================================

/**
 * GET /get-inspections
 *
 * Fetches RO and inspection data from Tekmetric API.
 * Routes through video-processor because Railway IP can reach TM API
 * (Supabase Edge Functions IP is blocked by Tekmetric).
 *
 * Query params:
 * - shopId: TekMetric shop ID (required)
 * - roNumber: Repair order number to search for (required)
 *
 * Returns:
 * - roId, roNumber, customer, vehicle, tasks[]
 */
router.get('/get-inspections', async (req, res) => {
  const { shopId, roNumber } = req.query;

  console.log(`[inspections] Looking up RO ${roNumber} for shop ${shopId}`);

  if (!shopId || !roNumber) {
    return res.status(400).json({ error: 'Missing required params: shopId, roNumber' });
  }

  try {
    // Get JWT token from AUTH-HUB
    const jwtToken = await getJWTToken(shopId);
    if (!jwtToken) {
      return res.status(401).json({ error: 'NO_TOKEN', details: 'No JWT token available for this shop' });
    }

    // Search for RO by number
    console.log(`[inspections] Searching TM API for RO ${roNumber}...`);
    const searchResult = await proxyToTM(
      `/api/shop/${shopId}/repair-orders?search=${encodeURIComponent(roNumber)}&size=10`,
      'GET',
      null,
      jwtToken
    );

    if (searchResult.status !== 200) {
      console.error(`[inspections] TM search failed: ${searchResult.status} - ${searchResult.body}`);
      return res.status(searchResult.status).json({
        error: 'RO_SEARCH_FAILED',
        details: `TM API returned ${searchResult.status}`,
        body: searchResult.body
      });
    }

    const searchData = JSON.parse(searchResult.body);
    const ros = searchData.content || [];

    // Find exact RO number match
    const ro = ros.find((r) => String(r.repairOrderNumber) === String(roNumber));
    if (!ro) {
      return res.status(404).json({ error: 'RO_NOT_FOUND', details: `RO ${roNumber} not found` });
    }

    console.log(`[inspections] Found RO ${ro.id}, fetching inspections...`);

    // Get inspections for this RO
    const inspResult = await proxyToTM(
      `/api/shop/${shopId}/repair-orders/${ro.id}/inspections`,
      'GET',
      null,
      jwtToken
    );

    if (inspResult.status !== 200) {
      console.error(`[inspections] TM inspections failed: ${inspResult.status} - ${inspResult.body}`);
      return res.status(inspResult.status).json({
        error: 'INSPECTIONS_FETCH_FAILED',
        details: `TM API returned ${inspResult.status}`,
        body: inspResult.body
      });
    }

    const inspectionsRaw = JSON.parse(inspResult.body);

    // Handle both array and single object responses from TekMetric
    const inspections = Array.isArray(inspectionsRaw) ? inspectionsRaw : [inspectionsRaw];

    // Extract tasks from all inspections
    // TekMetric returns tasks in two different structures:
    // 1. inspection.tasks - flat array of tasks
    // 2. inspection.inspectionTasks - nested sections containing tasks
    const tasks = [];

    for (const insp of inspections) {
      // Handle flat tasks array (Structure 1)
      const directTasks = insp.tasks || [];
      for (const task of directTasks) {
        tasks.push({
          id: task.id,
          name: task.name,
          inspectionId: insp.id,
          inspectionName: insp.name || '',
          rating: task.inspectionRating?.code || null,
          finding: task.finding || '',
          group: task.inspectionGroup || '',
          groupSortOrder: task.groupSortOrder || 0,
          inspectionTaskId: task.inspectionTaskId,
          externalImages: task.externalImages || []
        });
      }

      // Handle nested inspectionTasks structure (Structure 2)
      const nestedSections = insp.inspectionTasks || [];
      for (const section of nestedSections) {
        const sectionTasks = section.tasks || [];
        for (const task of sectionTasks) {
          tasks.push({
            id: task.id,
            name: task.name,
            inspectionId: insp.id,
            inspectionName: insp.name || '',
            rating: task.inspectionRating?.code || null,
            finding: task.finding || '',
            group: task.inspectionGroup || section.title || '',
            groupSortOrder: task.groupSortOrder || 0,
            inspectionTaskId: task.inspectionTaskId,
            externalImages: task.externalImages || []
          });
        }
      }
    }

    // Build customer and vehicle info
    // Use fullName if available (original behavior), otherwise build from parts
    const customer = ro.customer
      ? (ro.customer.fullName || `${ro.customer.firstName || ''} ${ro.customer.lastName || ''}`.trim())
      : 'Unknown';
    const vehicle = ro.vehicle
      ? (ro.vehicle.description || ro.vehicle.shortDescription || `${ro.vehicle.year || ''} ${ro.vehicle.make || ''} ${ro.vehicle.model || ''}`.trim())
      : 'Unknown';

    console.log(`[inspections] Returning ${tasks.length} tasks for RO ${roNumber}`);

    return res.json({
      roId: ro.id,
      roNumber: ro.repairOrderNumber,
      customer,
      vehicle,
      tasks
    });

  } catch (error) {
    console.error(`[inspections] Error:`, error.message);
    return res.status(500).json({
      error: 'INTERNAL_ERROR',
      details: error.message
    });
  }
});

/**
 * POST /merge-and-upload
 *
 * Accepts multipart form with:
 * - videoFile: The recorded issue video (required)
 * - shopId: TekMetric shop ID (required)
 * - roId: Repair order ID (required)
 * - inspectionId: Inspection ID (required)
 * - taskId: Task ID (required)
 * - taskName: Task name (optional)
 * - rating: GOOD, MAYRQRATTN, or RQRSATTN (optional)
 * - description: Finding description (optional)
 * - explainerVideoId: Supabase explainer video ID (optional)
 * - taskData: JSON string with additional task data (optional)
 *
 * If explainerVideoId is provided, fetches explainer from Supabase and merges
 * with the issue video before uploading to TekMetric.
 */
router.post('/merge-and-upload', async (req, res) => {
  console.log('[video] Processing merge-and-upload request...');

  let needsCleanup = [];

  try {
    // Parse multipart form data
    const { fields, videoFile } = await parseMultipart(req);
    const { shopId, roId, inspectionId, taskId, taskName, rating, description, explainerVideoId, taskData } = fields;

    // Validate required fields
    if (!videoFile) {
      return res.status(400).json({ error: 'No video file uploaded' });
    }

    needsCleanup.push(videoFile.path);

    if (!shopId || !roId || !inspectionId || !taskId) {
      cleanup(needsCleanup);
      return res.status(400).json({ error: 'Missing required fields: shopId, roId, inspectionId, taskId' });
    }

    console.log(`   Shop: ${shopId}, RO: ${roId}, Task: ${taskId}`);
    console.log(`   Video: ${videoFile.filename} (${(fs.statSync(videoFile.path).size / 1024 / 1024).toFixed(2)} MB)`);
    console.log(`   Explainer ID: ${explainerVideoId || 'none'}`);

    let finalVideoPath = videoFile.path;

    // If explainer selected, merge videos
    if (explainerVideoId) {
      console.log('[video] Fetching explainer video info...');
      const explainer = await getExplainerVideoUrl(explainerVideoId);

      if (explainer && explainer.file_url) {
        console.log(`   Explainer: ${explainer.name}`);

        const explainerPath = path.join(os.tmpdir(), `explainer-${Date.now()}.mp4`);
        needsCleanup.push(explainerPath);

        console.log('[video] Downloading explainer video...');
        await downloadFile(explainer.file_url, explainerPath);
        console.log(`   Downloaded: ${(fs.statSync(explainerPath).size / 1024 / 1024).toFixed(2)} MB`);

        const mergedPath = path.join(os.tmpdir(), `merged-${Date.now()}.mp4`);
        needsCleanup.push(mergedPath);

        await mergeVideos(videoFile.path, explainerPath, mergedPath);
        finalVideoPath = mergedPath;

        console.log(`   Merged video: ${(fs.statSync(mergedPath).size / 1024 / 1024).toFixed(2)} MB`);
      } else {
        console.log('[video] Explainer not found, uploading original');
      }
    }

    // Get JWT token from AUTH-HUB
    const jwtToken = await getJWTToken(shopId);
    if (!jwtToken) throw new Error('No JWT token available');

    // Get presigned upload URL from TekMetric
    console.log('[video] Getting presigned upload URL...');
    const presignedResult = await proxyToTM(
      `/media/create-video-upload-url`,
      'POST',
      {
        files: [{ name: `inspection-${Date.now()}.mp4`, mimetype: 'video/mp4' }],
        shopId: parseInt(shopId),
        repairOrderId: parseInt(roId),
        roInspectionId: parseInt(inspectionId),
        roInspectionTaskId: parseInt(taskId)
      },
      jwtToken
    );

    console.log(`   TM API status: ${presignedResult.status}`);

    if (presignedResult.status !== 200) {
      throw new Error(`Failed to get presigned URL (${presignedResult.status}): ${presignedResult.body}`);
    }

    const presignedData = JSON.parse(presignedResult.body);
    const videoData = presignedData.data?.[0];
    if (!videoData || !videoData.s3) {
      throw new Error(`Invalid response structure: ${JSON.stringify(presignedData).substring(0, 300)}`);
    }

    const s3Url = videoData.s3.url;
    const s3Fields = videoData.s3.fields;
    const s3Key = videoData.path;

    console.log(`   S3 bucket: ${s3Url}`);
    console.log(`   S3 key: ${s3Key}`);

    // Upload to S3 via multipart form POST
    await uploadToS3Form(s3Url, s3Fields, s3Key, finalVideoPath, 'video/mp4');

    // Update inspection task in TekMetric
    const task = taskData ? JSON.parse(taskData) : {};
    const ratingMap = { 'GOOD': 1, 'MAYRQRATTN': 2, 'RQRSATTN': 3 };
    const ratingId = ratingMap[rating] || 3;

    console.log('[video] Updating inspection task...');
    const taskUpdate = {
      id: parseInt(taskId),
      name: taskName || task?.name || 'Inspection Item',
      inspectionRating: {
        id: ratingId,
        code: rating || 'RQRSATTN',
        name: ratingId === 1 ? 'Good' : ratingId === 2 ? 'May Require Attention' : 'Requires Immediate Attention'
      },
      finding: description || '',
      inspectionGroup: task?.group || '',
      groupSortOrder: task?.groupSortOrder || 0,
      reported: true,
      externalImages: task?.externalImages || [],
      inspectionTaskId: task?.inspectionTaskId
    };

    await proxyToTM(
      `/api/shop/${shopId}/repair-orders/${roId}/inspections/${inspectionId}/tasks/${taskId}`,
      'PUT',
      taskUpdate,
      jwtToken
    );

    // Cleanup temp files
    cleanup(needsCleanup);

    console.log('[video] Upload complete!');
    return res.json({
      success: true,
      message: 'Video uploaded successfully',
      merged: !!explainerVideoId
    });

  } catch (error) {
    console.error('[video] Error:', error.message);
    cleanup(needsCleanup);
    return res.status(500).json({
      error: 'Video processing failed',
      message: error.message
    });
  }
});

/**
 * POST /merge-only
 *
 * Merges two videos without uploading to TekMetric.
 * Useful for testing or when upload is handled separately.
 *
 * Accepts multipart form with:
 * - videoFile: The primary video (required)
 * - explainerVideoId: Supabase explainer video ID (required)
 *
 * Returns the merged video file.
 */
router.post('/merge-only', async (req, res) => {
  console.log('[video] Processing merge-only request...');

  let needsCleanup = [];

  try {
    const { fields, videoFile } = await parseMultipart(req);
    const { explainerVideoId } = fields;

    if (!videoFile) {
      return res.status(400).json({ error: 'No video file uploaded' });
    }

    needsCleanup.push(videoFile.path);

    if (!explainerVideoId) {
      cleanup(needsCleanup);
      return res.status(400).json({ error: 'explainerVideoId is required for merge-only' });
    }

    console.log('[video] Fetching explainer video...');
    const explainer = await getExplainerVideoUrl(explainerVideoId);

    if (!explainer || !explainer.file_url) {
      cleanup(needsCleanup);
      return res.status(404).json({ error: 'Explainer video not found' });
    }

    const explainerPath = path.join(os.tmpdir(), `explainer-${Date.now()}.mp4`);
    needsCleanup.push(explainerPath);

    console.log('[video] Downloading explainer video...');
    await downloadFile(explainer.file_url, explainerPath);

    const mergedPath = path.join(os.tmpdir(), `merged-${Date.now()}.mp4`);
    needsCleanup.push(mergedPath);

    await mergeVideos(videoFile.path, explainerPath, mergedPath);

    // Send merged video file
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', 'attachment; filename="merged-video.mp4"');

    const fileStream = fs.createReadStream(mergedPath);
    fileStream.pipe(res);

    fileStream.on('end', () => {
      cleanup(needsCleanup);
    });

  } catch (error) {
    console.error('[video] Error:', error.message);
    cleanup(needsCleanup);
    return res.status(500).json({
      error: 'Video merge failed',
      message: error.message
    });
  }
});

/**
 * GET /health
 * Health check for video processing route
 */
router.get('/health', async (req, res) => {
  // Check if FFmpeg is available
  let ffmpegAvailable = false;
  try {
    await new Promise((resolve, reject) => {
      const ffmpeg = spawn('ffmpeg', ['-version']);
      ffmpeg.on('close', (code) => {
        ffmpegAvailable = code === 0;
        resolve();
      });
      ffmpeg.on('error', () => {
        ffmpegAvailable = false;
        resolve();
      });
    });
  } catch (e) {
    ffmpegAvailable = false;
  }

  res.json({
    status: 'healthy',
    route: 'video',
    ffmpeg_available: ffmpegAvailable,
    supabase_configured: !!(SUPABASE_URL && SUPABASE_ANON_KEY),
    temp_dir: os.tmpdir()
  });
});

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Cleanup temporary files
 */
function cleanup(files) {
  for (const filePath of files) {
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    } catch (e) {
      console.error(`[video] Failed to cleanup ${filePath}:`, e.message);
    }
  }
}

module.exports = router;
