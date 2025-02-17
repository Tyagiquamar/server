require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const http = require('http');
const { Server: WebSocketServer } = require('ws');
const twilio = require('twilio');
const speech = require('@google-cloud/speech'); // Use Google Cloud Speech-to-Text

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

// Twilio webhook for handling incoming calls
app.post('/voice', (req, res) => {
  const VoiceResponse = twilio.twiml.VoiceResponse;
  const twiml = new VoiceResponse();
  twiml.connect().stream({ url: `wss://${process.env.DOMAIN}/media-stream` });
  res.type('text/xml');
  res.send(twiml.toString());
});

// Create HTTP server
const server = http.createServer(app);

// WebSocket Server
const wss = new WebSocketServer({ server, path: '/media-stream' });

/**
 * Calls ElevenLabs API to generate speech from text.
 * Returns a base64-encoded string of the synthesized audio.
 */
const generateSpeech = async (text) => {
  try {
    console.log(`🗣️ Generating speech: "${text}"`);
    const url = `https://api.elevenlabs.io/v1/text-to-speech/${process.env.ELEVENLABS_VOICE_ID}`;
    const response = await axios.post(url, {
      text: text,
      model_id: "eleven_monolingual_v1",
      voice_settings: { stability: 0.7, similarity_boost: 0.7 }
    }, {
      headers: {
        "xi-api-key": process.env.XI_API_KEY,
        "Content-Type": "application/json",
        "Accept": "audio/mpeg"
      },
      responseType: 'arraybuffer'
    });

    return Buffer.from(response.data).toString('base64');
  } catch (error) {
    console.error("❌ Error generating speech:", error.response?.data || error);
    return null;
  }
};

/**
 * Calls Gemini or any other LLM to generate a response based on the input.
 * Returns the text response from Gemini.
 */
const generateGeminiResponse = async (inputText) => {
  try {
    const url = 'https://api.gemini.com/v1/query'; // Example placeholder for Gemini's API endpoint

    const response = await axios.post(url, {
      prompt: inputText, // Send the user's message to Gemini
      model: 'gemini',    // Specify the model if needed (adjust based on API specs)
      max_tokens: 150,    // Adjust as needed
    }, {
      headers: {
        'Authorization': `Bearer ${process.env.GEMINI_API_KEY}`, // Gemini API key
        'Content-Type': 'application/json',
      }
    });

    return response.data.response || "Sorry, I couldn't process your request."; // Return response text from Gemini
  } catch (error) {
    console.error("❌ Error generating response from Gemini:", error.response?.data || error);
    return "Sorry, there was an error while processing your request.";
  }
};

/**
 * Converts base64-encoded audio to text using Google Cloud Speech-to-Text
 */
const audioToText = async (audioBase64) => {
  try {
    const client = new speech.SpeechClient();

    // Convert base64 to buffer
    const audioBuffer = Buffer.from(audioBase64, 'base64');
    
    const audio = {
      content: audioBuffer.toString('base64'),
    };

    const config = {
      encoding: 'LINEAR16', // Adjust based on your audio encoding
      sampleRateHertz: 16000,
      languageCode: 'en-US',
    };

    const request = {
      audio: audio,
      config: config,
    };

    const [response] = await client.recognize(request);
    const transcript = response.results
      .map(result => result.alternatives[0].transcript)
      .join('\n');
    console.log(`Transcribed Text: ${transcript}`);
    return transcript;

  } catch (error) {
    console.error("❌ Error transcribing audio:", error);
    return "Sorry, I couldn't understand the audio.";
  }
};

/**
 * Handles DTMF (Keypad Input) from Twilio Calls
 */
const handleDTMF = async (digit, ws) => {
  console.log(`📞 Caller pressed digit: ${digit}`);
  let responseText = digit === "1"
    ? "You pressed one. Connecting you to sales."
    : digit === "2"
    ? "You pressed two. Connecting you to support."
    : "Invalid selection. Please press one for sales or two for support.";

  const audioBase64 = await generateSpeech(responseText);
  if (audioBase64) {
    ws.send(JSON.stringify({ event: "media", media: { payload: audioBase64 } }));
  }
};

// WebSocket Connection Handling
wss.on('connection', async (ws, req) => {
  console.log("✅ WebSocket connection established");

  // Greeting message
  const greetingText = "Hello, this is your AI assistant. Type or say something!";
  const audioBase64 = await generateSpeech(greetingText);
  if (audioBase64) {
    ws.send(JSON.stringify({ event: "media", media: { payload: audioBase64 } }));
  }

  // Handle Incoming Messages
  ws.on('message', async (message) => {
    console.log("📩 Received message:", message);
    try {
      const parsed = JSON.parse(message);

      if (parsed.event && parsed.event.toLowerCase() === "dtmf") {
        const digit = parsed.digits || parsed.Digits;
        if (digit) await handleDTMF(digit, ws);
      } else if (parsed.event && parsed.event.toLowerCase() === "audio") {
        // Handle audio input, convert audio to text
        const text = await audioToText(parsed.media.payload);

        // Generate response based on the transcribed text
        const responseText = await generateGeminiResponse(text);

        // Convert the response to speech and send it back to the client
        const audioBase64 = await generateSpeech(responseText);
        if (audioBase64) {
          ws.send(JSON.stringify({ event: "media", media: { payload: audioBase64 } }));
        }

        // Send the text response back as well
        ws.send(JSON.stringify({ event: "text", text: responseText }));
      } else if (parsed.text) {
        console.log("💬 User said:", parsed.text);
        let responseText;

        if (parsed.text.toLowerCase().includes("hello")) {
          responseText = "Hello! How can I assist you today?";
        } else if (parsed.text.toLowerCase().includes("help")) {
          responseText = "I can assist with general queries. Just type your question!";
        } else {
          // Pass the user input to Gemini for processing
          responseText = await generateGeminiResponse(parsed.text);
        }

        // Generate AI voice response
        const audioBase64 = await generateSpeech(responseText);
        if (audioBase64) {
          ws.send(JSON.stringify({ event: "media", media: { payload: audioBase64 } }));
        }

        // Send text response
        ws.send(JSON.stringify({ event: "text", text: responseText }));
      }
    } catch (err) {
      console.error("❌ Error parsing message:", err);
    }
  });

  ws.on('close', () => console.log("❌ WebSocket connection closed"));
});

// Start the server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
