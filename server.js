const express = require('express');
const path = require('path');
const cors = require('cors');
const { google } = require('googleapis');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const axios = require('axios');
require('dotenv').config();
const localPhotos = require('./local-photos-router');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));
app.use(localPhotos); // Boundary Waters local photo library

// Google APIs setup (for calendar and tasks)
let calendar = null;
let tasks = null;

// Calendar allowlist — only fetch from these calendars.
// Set CALENDAR_IDS in .env as a comma-separated list of Google Calendar IDs.
// Example: CALENDAR_IDS=you@gmail.com,shared@group.calendar.google.com,en.usa#holiday@group.v.calendar.google.com
const CALENDAR_ALLOWLIST = new Set(
  (process.env.CALENDAR_IDS || '')
    .split(',')
    .map(id => id.trim())
    .filter(Boolean)
);

// Gemini AI setup
let gemini = null;
if (process.env.GEMINI_API_KEY) {
    gemini = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    console.log('✅ Google Gemini AI initialized successfully');
} else {
    console.log('⚠️ Gemini API key not found');
}

try {
  const fs = require('fs');
  const path = require('path');
  const credentialsPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  const tokenPath = path.join(process.cwd(), 'token.json');
  
  if (credentialsPath && fs.existsSync(credentialsPath)) {
    const credentials = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'));
    
    // Check if it's OAuth2 credentials (has installed or web property)
    if (credentials.installed || credentials.web) {
      // Load saved token if it exists
      let auth = null;
      if (fs.existsSync(tokenPath)) {
        try {
          const token = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));
          auth = google.auth.fromJSON(token);
          // Explicitly set scopes so fromJSON doesn't silently drop them
          auth.scopes = [
            'https://www.googleapis.com/auth/calendar.readonly',
            'https://www.googleapis.com/auth/tasks.readonly'
          ];
          console.log('✅ Loaded existing OAuth2 token');
        } catch (error) {
          console.log('⚠️ Failed to load existing token, will need re-authentication');
        }
      }
      
      if (!auth) {
        // For server environment, we'll use fallback since OAuth2 requires browser interaction
        console.log('⚠️ OAuth2 requires browser interaction for initial setup');
        console.log('📝 Using fallback mock calendar data');
        console.log('💡 To enable real Google Calendar:');
        console.log('   1. Run the OAuth2 setup locally with browser access');
        console.log('   2. Copy the generated token.json to your server');
      } else {
        calendar = google.calendar({ version: 'v3', auth });
        tasks = google.tasks({ version: 'v1', auth });
        console.log('✅ Google Calendar API initialized successfully with OAuth2');
        console.log('✅ Google Tasks API initialized successfully with OAuth2');
      }
    } else {
      console.log('⚠️ Credentials file is not OAuth2 format (missing installed/web property)');
      console.log('📝 Using fallback mock calendar data');
    }
  } else {
    console.log('⚠️ Google credentials file not found');
    console.log('📝 Using fallback mock calendar data');
  }
} catch (error) {
  console.log('⚠️ Google Calendar API initialization failed:', error.message);
  console.log('📝 Using fallback mock calendar data');
}

// Routes
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Plex Photos endpoint — navigates the year → album → photo hierarchy to return
// a random batch of 25 photos. Each call drills into a different random year/album
// so the slideshow rotates across the full library over time.
app.get('/api/photos/:query?', async (req, res) => {
  const plexUrl   = process.env.PLEX_URL;
  const plexToken = process.env.PLEX_TOKEN;
  const sectionId = process.env.PLEX_PHOTO_SECTION_ID || '11';
  const batchSize = 25;

  if (!plexUrl || !plexToken) {
    console.log('⚠️ Plex not configured — PLEX_URL and PLEX_TOKEN required in .env');
    return res.status(503).json({ error: 'Plex not configured' });
  }

  try {
    const authHeaders = { Accept: 'application/json', 'X-Plex-Token': plexToken };

    // Helper: fetch Metadata array from any Plex path
    async function plexGet(path) {
      const resp = await axios.get(`${plexUrl}${path}`, { headers: authHeaders });
      return resp.data.MediaContainer?.Metadata || [];
    }

    // Helper: does this item need drilling into (i.e. is it a directory/album)?
    const isDir = item => item.key && item.key.includes('/children');

    // Step 1: Get all top-level year/folder directories
    const topItems = await plexGet(`/library/sections/${sectionId}/all`);
    const topDirs  = topItems.filter(isDir);
    if (topDirs.length === 0) throw new Error('No photo directories found in library');

    // Step 2: Pick a random top-level directory
    const randDir  = topDirs[Math.floor(Math.random() * topDirs.length)];
    console.log(`📷 Plex: browsing "${randDir.title}"`);

    // Step 3: Get its children — may be albums or individual photos
    const level2      = await plexGet(randDir.key);
    const level2Dirs  = level2.filter(isDir);
    let   photos      = level2.filter(i => !isDir(i) && i.thumb);

    // Step 4: If children are albums, drill into a random one
    if (photos.length === 0 && level2Dirs.length > 0) {
      const randAlbum = level2Dirs[Math.floor(Math.random() * level2Dirs.length)];
      console.log(`📷 Plex: drilling into album "${randAlbum.title}"`);
      const level3 = await plexGet(randAlbum.key);
      photos = level3.filter(i => !isDir(i) && i.thumb);
    }

    if (photos.length === 0) throw new Error(`No photos found under "${randDir.title}"`);

    // Shuffle and return up to batchSize
    const selected = photos.sort(() => Math.random() - 0.5).slice(0, batchSize);
    console.log(`📷 Plex: returning ${selected.length} photos`);

    res.json({
      mediaItems: selected.map(photo => ({
        id:              photo.ratingKey,
        baseUrl:         `/api/photo-proxy${photo.thumb}`,
        filename:        photo.title || '',
        photographer:    '',   // personal family photos — no attribution
        photographerUrl: ''
      }))
    });
  } catch (error) {
    console.error('Error fetching Plex photos:', error.message);
    res.status(500).json({ error: 'Failed to fetch photos from Plex' });
  }
});

// Plex photo proxy — fetches from Plex using the server-side token and streams
// the image back to the browser. The Plex token never appears in frontend URLs.
// Uses Plex's built-in transcoder to serve images sized for the 1024×600 display.
app.get('/api/photo-proxy/*', async (req, res) => {
  const plexUrl   = process.env.PLEX_URL;
  const plexToken = process.env.PLEX_TOKEN;

  if (!plexUrl || !plexToken) {
    return res.status(503).send('Plex not configured');
  }

  try {
    const plexPath = req.params[0]; // e.g. library/metadata/93287/thumb/1531974498
    // Use Plex's photo transcoder to deliver a display-sized image (1024×600)
    const transcodeUrl = `${plexUrl}/photo/:/transcode?url=/${plexPath}&width=1024&height=600&minSize=1&X-Plex-Token=${plexToken}`;

    const imageResp = await axios.get(transcodeUrl, { responseType: 'stream' });
    res.set('Content-Type', imageResp.headers['content-type'] || 'image/jpeg');
    res.set('Cache-Control', 'public, max-age=3600'); // Cache on the Pi for 1 hour
    imageResp.data.pipe(res);
  } catch (error) {
    console.error('Plex photo proxy error:', error.message);
    res.status(500).send('Failed to load photo');
  }
});

// Google Calendar API endpoint
app.get('/api/calendar/events', async (req, res) => {
  try {
    if (!calendar) {
      console.log('Calendar API not yet initialized — returning 503 for client retry');
      return res.status(503).json({ error: 'Calendar API initializing, retry shortly' });
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const endTime = new Date(today.getTime() + (7 * 24 * 60 * 60 * 1000)); // 7 days

    // Fetch calendar list, filter to allowlist, query each in parallel
    const calListResponse = await calendar.calendarList.list();
    const calendarIds = (calListResponse.data.items || [])
      .filter(c => CALENDAR_ALLOWLIST.has(c.id))
      .map(c => c.id);

    const allEvents = await Promise.all(calendarIds.map(id =>
      calendar.events.list({
        calendarId: id,
        timeMin: today.toISOString(),
        timeMax: endTime.toISOString(),
        singleEvents: true,
        orderBy: 'startTime',
        maxResults: 50
      }).then(r => r.data.items || []).catch(() => [])
    ));

    // Merge, deduplicate by event id, sort by start time
    const merged = Object.values(
      allEvents.flat().reduce((acc, e) => { acc[e.id] = e; return acc; }, {})
    ).sort((a, b) => {
      const aTime = a.start.dateTime || a.start.date;
      const bTime = b.start.dateTime || b.start.date;
      return aTime < bTime ? -1 : 1;
    });

    res.json(merged);
  } catch (error) {
    console.error('Error fetching calendar events:', error);
    res.json([]);
  }
});

// Google Tasks API endpoint
app.get('/api/tasks', async (req, res) => {
  try {
    if (!tasks) {
      console.log('No Google Tasks API available, returning empty tasks data');
      return res.json([]);
    }

    const response = await tasks.tasklists.list();
    const taskLists = response.data.items || [];
    
    if (taskLists.length === 0) {
      return res.json([]);
    }

    // Get tasks from the first task list (usually "My Tasks")
    const taskListId = taskLists[0].id;
    const tasksResponse = await tasks.tasks.list({
      tasklist: taskListId,
      showCompleted: false,
      maxResults: 20
    });

    const taskItems = tasksResponse.data.items || [];
    const formattedTasks = taskItems.map(task => ({
      title: task.title,
      notes: task.notes || '',
      due: task.due || null
    }));

    res.json(formattedTasks);
  } catch (error) {
    console.error('Error fetching tasks:', error);
    res.json([]);
  }
});

// Google Calendar API endpoint — rolling 7-day agenda (default) or arbitrary range.
// Optional query params: ?start=YYYY-MM-DD&end=YYYY-MM-DD
// Used by the rolling agenda view (no params) and month grid view (with params).
app.get('/api/calendar/agenda', async (req, res) => {
  try {
    if (!calendar) {
      console.log('Calendar API not yet initialized — returning 503 for client retry');
      return res.status(503).json({ error: 'Calendar API initializing, retry shortly' });
    }

    let timeMin, timeMax;
    if (req.query.start && req.query.end) {
      // Month view range request — parse YYYY-MM-DD strings as local midnight
      const startParts = req.query.start.split('-').map(Number);
      const endParts   = req.query.end.split('-').map(Number);
      timeMin = new Date(startParts[0], startParts[1] - 1, startParts[2], 0, 0, 0, 0);
      timeMax = new Date(endParts[0],   endParts[1] - 1,   endParts[2],   23, 59, 59, 999);
    } else {
      // Default rolling 7-day window
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      timeMin = today;
      timeMax = new Date(today.getTime() + (7 * 24 * 60 * 60 * 1000));
    }

    // Fetch calendar list, filter to allowlist, query each in parallel
    const calListResponse = await calendar.calendarList.list();
    const calendarIds = (calListResponse.data.items || [])
      .filter(c => CALENDAR_ALLOWLIST.has(c.id))
      .map(c => c.id);

    const allEvents = await Promise.all(calendarIds.map(id =>
      calendar.events.list({
        calendarId: id,
        timeMin: timeMin.toISOString(),
        timeMax: timeMax.toISOString(),
        singleEvents: true,
        orderBy: 'startTime',
        maxResults: 100   // Raised from 50 — month view can have more events
      }).then(r => r.data.items || []).catch(() => [])
    ));

    // Merge, deduplicate by event id, sort by start time
    const merged = Object.values(
      allEvents.flat().reduce((acc, e) => { acc[e.id] = e; return acc; }, {})
    ).sort((a, b) => {
      const aTime = a.start.dateTime || a.start.date;
      const bTime = b.start.dateTime || b.start.date;
      return aTime < bTime ? -1 : 1;
    });

    res.json(merged);
  } catch (error) {
    console.error('Error fetching calendar agenda:', error);
    // Return mock data on error
    const mockEvents = [];
    for (let i = 0; i < 7; i++) {
      const date = new Date(Date.now() + i * 24 * 60 * 60 * 1000);
      mockEvents.push({
        id: `mock${i + 1}`,
        summary: `Event ${i + 1}`,
        start: { dateTime: new Date(date.getTime() + 9 * 60 * 60 * 1000).toISOString() },
        end: { dateTime: new Date(date.getTime() + 10 * 60 * 60 * 1000).toISOString() }
      });
    }
    res.json(mockEvents);
  }
});

// Weather API endpoint (using OpenMeteo)
app.get('/api/weather', async (req, res) => {
  try {
    const rawLat = req.query.lat;
    const rawLon = req.query.lon;
    const lat = (rawLat && rawLat !== 'undefined') ? rawLat : process.env.LATITUDE;
    const lon = (rawLon && rawLon !== 'undefined') ? rawLon : process.env.LONGITUDE;

    if (!lat || !lon) {
      console.error('[Weather] No lat/lon in query or .env');
      return res.status(500).json({ error: 'Server misconfiguration: LATITUDE/LONGITUDE not set' });
    }

    const response = await fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,weather_code,relative_humidity_2m,wind_speed_10m,wind_direction_10m,wind_gusts_10m,uv_index&hourly=temperature_2m,weather_code,relative_humidity_2m,wind_speed_10m,wind_direction_10m,precipitation_probability,wind_gusts_10m,uv_index&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,wind_speed_10m_max,wind_gusts_10m_max,uv_index_max&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=America/Chicago`
    );

    const contentType = response.headers.get('content-type') ?? '';
    if (!response.ok || !contentType.includes('application/json')) {
      const body = await response.text();
      console.error(`[Weather] Open-Meteo returned ${response.status}. Body: ${body.slice(0, 200)}`);
      return res.status(502).json({ error: `Upstream weather API error (HTTP ${response.status})` });
    }

    const weatherData = await response.json();
    res.json(weatherData);
  } catch (error) {
    console.error('[Weather] Fetch failed:', error.message);
    res.status(500).json({ error: 'Failed to fetch weather data' });
  }
});

// Cache for hourly summary to avoid repeated API calls
let summaryCache = null;
let summaryCacheHour = null;

// Hourly Summary API endpoint using Gemini AI
app.get('/api/summary', async (req, res) => {
  const cacheHour = new Date().getHours();
  try {
    // Check cache first - generate once per hour, unless refresh is requested
    const isRefreshRequest = req.query.refresh;
    
    // Clear cache if refresh is requested
    if (isRefreshRequest) {
      summaryCache = null;
      summaryCacheHour = null;
    }
    
    if (!isRefreshRequest && summaryCache && summaryCacheHour === cacheHour) {
      return res.json(summaryCache);
    }

    if (!gemini) {
      const fallbackSummary = {
        summary: "Hourly summary is not available. Please configure Gemini API key.",
        timestamp: new Date().toISOString()
      };
      summaryCache = fallbackSummary;
      summaryCacheHour = cacheHour;
      return res.json(fallbackSummary);
    }

    // Fetch all data sources with timeout
    const timeout = 10000; // 10 second timeout
    const [weatherResponse, hourlyWeatherResponse, calendarResponse] = await Promise.allSettled([
      Promise.race([
        axios.get(`http://localhost:${PORT}/api/weather?lat=${process.env.LATITUDE}&lon=${process.env.LONGITUDE}`),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Weather timeout')), timeout))
      ]),
      Promise.race([
        axios.get(`https://api.open-meteo.com/v1/forecast?latitude=${process.env.LATITUDE}&longitude=${process.env.LONGITUDE}&hourly=temperature_2m,relative_humidity_2m,precipitation_probability,weather_code,wind_speed_10m,wind_direction_10m,uv_index&temperature_unit=fahrenheit&timezone=auto`),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Hourly weather timeout')), timeout))
      ]),
      Promise.race([
        axios.get(`http://localhost:${PORT}/api/calendar/events`),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Calendar timeout')), timeout))
      ])
    ]);

    // Skip tasks API for now due to permission issues
    const tasksResponse = { status: 'rejected', reason: new Error('Tasks API not available') };

    // Prepare data for AI
    const weatherData = weatherResponse.status === 'fulfilled' ? weatherResponse.value.data : null;
    const hourlyWeatherData = hourlyWeatherResponse.status === 'fulfilled' ? hourlyWeatherResponse.value.data : null;
    const calendarData = calendarResponse.status === 'fulfilled' ? calendarResponse.value.data : [];
    const tasksData = tasksResponse.status === 'fulfilled' ? tasksResponse.value.data : [];

    // Get current time context
    const now = new Date();
    const currentHour = now.getHours();
    const timeOfDay = currentHour < 12 ? 'morning' : currentHour < 17 ? 'afternoon' : 'evening';
    const isWeekend = now.getDay() === 0 || now.getDay() === 6;

    // Temperature data is already in Fahrenheit (API called with temperature_unit=fahrenheit)

    // Format data for AI prompt
    const city = process.env.CITY || 'your area';
    const householdName = process.env.HOUSEHOLD_NAME || 'the household';
    let dataSummary = `Location: ${city}. `;
    
    if (weatherData && hourlyWeatherData) {
      const current = weatherData.current;
      const daily = weatherData.daily;
      const hourly = hourlyWeatherData.hourly;
      
      // Find current hour index
      const currentHourIndex = hourly.time.findIndex(time => {
        const hourTime = new Date(time);
        return hourTime.getHours() === currentHour;
      });
      
      // Get next few hours for context
      const nextHours = [];
      for (let i = 1; i <= 6; i++) {
        const nextIndex = currentHourIndex + i;
        if (nextIndex < hourly.time.length) {
          const nextTime = new Date(hourly.time[nextIndex]);
          const nextHour = nextTime.getHours();
          const nextTemp = Math.round(hourly.temperature_2m[nextIndex]);
          const nextPrecip = hourly.precipitation_probability[nextIndex];
          const nextWeather = hourly.weather_code[nextIndex];
          nextHours.push({
            hour: nextHour,
            temp: nextTemp,
            precip: nextPrecip,
            weather: nextWeather
          });
        }
      }
      
      dataSummary += `Current Time Context: It's currently ${timeOfDay} (${currentHour}:00). ${isWeekend ? 'It\'s the weekend, so you might have more flexibility in your schedule.' : 'It\'s a weekday, so you\'re likely in the middle of your work routine.'} `;
      
      dataSummary += `Weather: Current temperature ${Math.round(current.temperature_2m)}°F, humidity ${current.relative_humidity_2m}%, wind speed ${current.wind_speed_10m} mph, wind direction ${current.wind_direction_10m}°, wind gusts ${current.wind_gusts_10m} mph, UV index ${current.uv_index || 'N/A'}. Today's forecast: High ${Math.round(daily.temperature_2m_max[0])}°F, Low ${Math.round(daily.temperature_2m_min[0])}°F, max wind speed ${daily.wind_speed_10m_max[0]} mph, max wind gusts ${daily.wind_gusts_10m_max[0]} mph, precipitation probability ${daily.precipitation_probability_max[0]}%, max UV index ${daily.uv_index_max ? daily.uv_index_max[0] : 'N/A'}. `;

      // Add tomorrow's forecast if available (daily[1])
      if (daily.temperature_2m_max[1] !== undefined) {
        dataSummary += `Tomorrow's forecast: High ${Math.round(daily.temperature_2m_max[1])}°F, Low ${Math.round(daily.temperature_2m_min[1])}°F, precipitation probability ${daily.precipitation_probability_max[1]}%, max wind speed ${daily.wind_speed_10m_max[1]} mph, max UV index ${daily.uv_index_max ? daily.uv_index_max[1] : 'N/A'}. `;
      }
      
      // Add hourly forecast context
      if (nextHours.length > 0) {
        dataSummary += `Next few hours: `;
        nextHours.forEach((hour, index) => {
          const hourLabel = hour.hour === 0 ? 'midnight' : hour.hour === 12 ? 'noon' : hour.hour > 12 ? `${hour.hour - 12} PM` : `${hour.hour} AM`;
          dataSummary += `${hourLabel} will be ${hour.temp}°F with ${hour.precip}% chance of rain`;
          if (index < nextHours.length - 1) dataSummary += ', ';
        });
        dataSummary += '. ';
      }
    }
    
    if (calendarData && calendarData.length > 0) {
      // Validate and filter calendar events to prevent hallucination
      const validEvents = calendarData.filter(event => {
        // Ensure event has required properties
        if (!event || !event.summary || !event.start) {
          return false;
        }
        
        // Validate event summary is not empty or suspicious
        const summary = event.summary.trim();
        if (!summary || summary.length < 1 || summary.length > 200) {
          return false;
        }
        
        // Check for suspicious patterns that might indicate mock data
        const suspiciousPatterns = ['mock', 'test', 'example', 'sample', 'placeholder'];
        if (suspiciousPatterns.some(pattern => summary.toLowerCase().includes(pattern))) {
          return false;
        }
        
        // Validate start date
        try {
          const start = new Date(event.start.dateTime || event.start.date);
          if (isNaN(start.getTime())) {
            return false;
          }
          
          // Only include events within reasonable time range (past 24 hours to next 7 days)
          const now = new Date();
          const past24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);
          const next7days = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
          
          if (start < past24h || start > next7days) {
            return false;
          }
          
          return true;
        } catch (error) {
          return false;
        }
      });
      
      if (validEvents.length > 0) {
        console.log('Valid calendar events being sent to Gemini:', validEvents.length);
        dataSummary += `Calendar Events: ${validEvents.map(event => {
          const start = new Date(event.start.dateTime || event.start.date);
          const time = event.start.dateTime ? start.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true }) : 'All day';
          return `${time} - ${event.summary}`;
        }).join(', ')}. `;
      } else {
        console.log('No valid calendar events found, sending empty calendar data to Gemini');
        dataSummary += `Calendar Events: No upcoming events scheduled. `;
      }
    } else {
      dataSummary += `Calendar Events: No upcoming events scheduled. `;
    }
    
    if (tasksData && tasksData.length > 0) {
      // Validate and filter tasks to prevent hallucination
      const validTasks = tasksData.filter(task => {
        // Ensure task has required properties
        if (!task || !task.title) {
          return false;
        }
        
        // Validate task title is not empty or suspicious
        const title = task.title.trim();
        if (!title || title.length < 1 || title.length > 200) {
          return false;
        }
        
        // Check for suspicious patterns that might indicate mock data
        const suspiciousPatterns = ['mock', 'test', 'example', 'sample', 'placeholder'];
        if (suspiciousPatterns.some(pattern => title.toLowerCase().includes(pattern))) {
          return false;
        }
        
        return true;
      });
      
      if (validTasks.length > 0) {
        console.log('Valid tasks being sent to Gemini:', validTasks.length);
        dataSummary += `Tasks: ${validTasks.map(task => task.title).join(', ')}. `;
      } else {
        console.log('No valid tasks found, sending empty tasks data to Gemini');
        dataSummary += `Tasks: No pending tasks. `;
      }
    } else {
      dataSummary += `Tasks: No pending tasks. `;
    }

    // Get user name from query parameter or use default
    const userName = req.query.name || 'the family';

    // Determine whether to include sailing/lake conditions section.
    // Only relevant May–October (months 4–9) and when current temp is above 50°F.
    const currentMonth = now.getMonth();
    const currentTempF = weatherData ? weatherData.current.temperature_2m : 0;
    const isSailingSeason = currentMonth >= 4 && currentMonth <= 9 && currentTempF > 50;

    const sailingSection = isSailingSeason ? `
4. **Lake & Sailing Conditions** (include because it is sailing season):
   - <h2>Lake Conditions:</h2>
   - Assess sailing suitability based on wind speed (5–15 mph = good, 15–25 mph = fun and thrilling, 25+ mph = not recommended) and gust spread
   - Note any precipitation risk that affects time on the water
   - Format as a short paragraph <p>...</p>
` : '';

    // Create AI prompt
    const prompt = `Here is today's data for ${householdName}:

${dataSummary}

Generate a daily briefing as pure HTML — no markdown, no code blocks, no backticks. Wrap key numbers (temperatures, wind speeds, percentages) in <span class="weather-highlight">. Return only the HTML, nothing else.

Structure the output in this exact order:

1. **Greeting and weather snapshot**
   - <h1>Good ${timeOfDay}, ${userName}!</h1>
   - Follow with a single <h1> covering current conditions in natural sentence form: current temp, today's high/low, humidity, wind speed and direction, gusts, and UV index. Use weather-highlight spans on every number.

2. **Before you head out**
   - <h2>Before You Head Out:</h2>
   - One focused <p> that connects the weather to the day's schedule. If there are calendar events, cross-reference their timing against the hourly forecast — flag temperature drops, precipitation windows, or anything that affects how someone should prepare. Recommend what to wear based on actual conditions (temp + wind + precip). If UV is high, mention sunscreen. Make it genuinely useful, not generic.

3. **Today's events**
   - <h2>Today's Events:</h2>
   - <ul> with one <li> per event: <li><strong>[time]</strong> — [event name]</li>
   - All-day events: <li><strong>All day</strong> — [event name]</li>
   - If no events today: <p>Nothing on the calendar today.</p>
   - CRITICAL: Only include events explicitly present in the data. Do not invent events.

4. **Tomorrow's events**
   - <h2>Tomorrow's Events:</h2>
   - Same format as today's events
   - CRITICAL: Only include events explicitly present in the data. Do not invent events.
${sailingSection}
5. **Later this week** (include ONLY if there are calendar events beyond tomorrow)
   - <h2>Later This Week:</h2>
   - 2–3 sentences max. Synthesize what is worth flagging — do not list every event verbatim. Skip this section entirely if there are no events beyond tomorrow.

6. **Tomorrow's outlook**
   - <h2 class="daily-affirmation">Tomorrow's Outlook:</h2>
   - <h3>[One sentence weather preview for tomorrow — temperature range, precipitation if any, overall vibe. Useful, not decorative.]</h3>

Return ONLY the HTML. No preamble, no explanation, no code fences.`;

    // Generate summary using Gemini with timeout.
    // HOUSEHOLD_DESCRIPTION lets you give the model context about who lives there
    // (names, ages, interests) so the briefing is personalized. Optional — falls back to generic.
    const householdDescription = process.env.HOUSEHOLD_DESCRIPTION
      || `a household in ${city}`;
    const systemInstruction = `You are a home assistant dashboard for ${householdDescription}. The audience is the whole household — keep it warm but useful, not corporate. Today's content is below.`;

    const model = gemini.getGenerativeModel({
      model: "gemini-2.5-flash",
      systemInstruction: systemInstruction
    });
    const result = await Promise.race([
      model.generateContent(prompt),
      new Promise((_, reject) => setTimeout(() => reject(new Error('AI generation timeout')), 60000))
    ]);
    const response = await result.response;
    const summary = response.text();

    const summaryData = {
      summary: summary,
      timestamp: new Date().toISOString(),
      data: {
        weather: weatherData ? 'Available' : 'Not available',
        calendar: calendarData.length,
        tasks: tasksData.length
      }
    };

    // Cache the result for the hour
    summaryCache = summaryData;
    summaryCacheHour = cacheHour;

    res.json(summaryData);

  } catch (error) {
    console.error('Error generating daily summary:', error);
    
    // Return cached data if available, otherwise fallback
    if (summaryCache) {
      return res.json({
        ...summaryCache,
        note: 'Using cached data due to error'
      });
    }
    
    const fallbackSummary = {
      summary: "Sorry, I couldn't generate your daily summary right now. Please try again later.",
      timestamp: new Date().toISOString(),
      error: error.message
    };
    
    summaryCache = fallbackSummary;
    summaryCacheHour = cacheHour;
    
    res.status(500).json(fallbackSummary);
  }
});

app.listen(PORT, () => {
  console.log(`Smart Display server running on port ${PORT}`);
  console.log(`Open http://localhost:${PORT} in your browser`);
});
