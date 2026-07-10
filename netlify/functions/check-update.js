// Polling endpoint. The frontend hits this every ~2s with a jobId until the
// background function has written a "done" or "error" record to Blobs.

const { getStore } = require('@netlify/blobs');

const BLOBS_CONFIG = {
  siteID: process.env.NETLIFY_SITE_ID,
  token: process.env.NETLIFY_BLOBS_TOKEN
};

const JOB_ID_RE = /^[a-zA-Z0-9-]{1,64}$/;

exports.handler = async (event) => {
  const jobId = (event.queryStringParameters || {}).jobId;
  if (!jobId || !JOB_ID_RE.test(jobId)) {
    return json(400, { status: 'error', message: 'Missing or invalid jobId.' });
  }

  try {
    const store = getStore({ name: 'investor-updates', ...BLOBS_CONFIG });
    const record = await store.get(jobId, { type: 'json' });
    if (!record) {
      return json(200, { status: 'pending' });
    }
    return json(200, record);
  } catch (err) {
    // A just-created job may not be readable yet; treat as still pending.
    return json(200, { status: 'pending' });
  }
};

function json(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  };
}
