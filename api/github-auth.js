export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { code } = req.body;
  const clientId = process.env.GITHUB_CLIENT_ID;
  const clientSecret = process.env.GITHUB_CLIENT_SECRET;

  if (!code) {
    return res.status(400).json({ error: 'Missing authorization code' });
  }

  try {
    // Exchange code for access token
    const tokenResponse = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        code: code,
      }),
    });

    const tokenData = await tokenResponse.json();

    if (tokenData.error) {
      return res.status(400).json({ error: tokenData.error_description });
    }

    // Return the access token
    return res.status(200).json({
      access_token: tokenData.access_token,
      token_type: tokenData.token_type,
    });
  } catch (error) {
    console.error('Token exchange error:', error);
    return res.status(500).json({ error: 'Failed to exchange code for token' });
  }
}
