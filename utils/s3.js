/**
 * S3 Upload Utilities
 * Provides functions for uploading files to S3 using presigned URLs
 */

const https = require('https');
const fs = require('fs');

/**
 * Upload file to S3 via PUT request using presigned URL
 * @param {string} presignedUrl - The presigned S3 URL for PUT upload
 * @param {string} filePath - Local path to the file to upload
 * @param {string} contentType - MIME type of the file (e.g., 'video/mp4')
 * @returns {Promise<{success: boolean}>} - Resolves on success, rejects on failure
 */
function uploadToS3(presignedUrl, filePath, contentType) {
  return new Promise((resolve, reject) => {
    const fileSize = fs.statSync(filePath).size;
    const fileStream = fs.createReadStream(filePath);
    const urlObj = new URL(presignedUrl);

    console.log(`[S3] Uploading ${(fileSize / 1024 / 1024).toFixed(2)} MB via PUT...`);

    const req = https.request({
      hostname: urlObj.hostname,
      port: 443,
      path: urlObj.pathname + urlObj.search,
      method: 'PUT',
      headers: { 'Content-Type': contentType, 'Content-Length': fileSize }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) {
          console.log('[S3] PUT upload complete!');
          resolve({ success: true });
        } else {
          reject(new Error(`S3 PUT upload failed: ${res.statusCode} - ${data}`));
        }
      });
    });

    req.on('error', reject);
    fileStream.pipe(req);
  });
}

/**
 * Upload file to S3 via multipart form POST
 * @param {string} s3Url - The S3 bucket URL for POST upload
 * @param {Object} s3Fields - Signature fields from presigned POST (policy, signature, etc.)
 * @param {string} s3Key - The S3 object key (path/filename in bucket)
 * @param {string} filePath - Local path to the file to upload
 * @param {string} contentType - MIME type of the file (e.g., 'video/mp4')
 * @returns {Promise<{success: boolean}>} - Resolves on success, rejects on failure
 */
function uploadToS3Form(s3Url, s3Fields, s3Key, filePath, contentType) {
  return new Promise((resolve, reject) => {
    const fileSize = fs.statSync(filePath).size;
    const boundary = `----FormBoundary${Date.now()}`;
    const urlObj = new URL(s3Url);

    console.log(`[S3] Uploading ${(fileSize / 1024 / 1024).toFixed(2)} MB via POST...`);

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
          console.log('[S3] POST upload complete!');
          resolve({ success: true });
        } else {
          reject(new Error(`S3 POST upload failed: ${res.statusCode} - ${data}`));
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

module.exports = {
  uploadToS3,
  uploadToS3Form
};
