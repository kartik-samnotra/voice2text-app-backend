import express from "express";
import cors from "cors";
import multer from "multer";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import Deepgram from "@deepgram/sdk";
import { createClient } from "@supabase/supabase-js";

dotenv.config();

const app = express();
// --- CORS setup ---
const allowedOrigins = [
  "http://localhost:5173",            // for local dev (Vite)
  "https://voice2text-app.netlify.app/"    // your Netlify frontend URL
];

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error("Not allowed by CORS"));
    }
  },
  methods: ["GET", "POST"],
  credentials: true,
}));
app.use(express.json());

// --- Initialize Deepgram client ---
const deepgram = Deepgram.createClient(process.env.DEEPGRAM_API_KEY);

// --- Initialize Supabase client ---
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// --- Multer setup for file uploads ---
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadPath = "uploads/";
    if (!fs.existsSync(uploadPath)) {
  fs.mkdirSync(uploadPath, { recursive: true });
}
    }
    cb(null, uploadPath);
  },
  filename: (req, file, cb) => {
    cb(null, `${Date.now()}-${file.originalname}`);
  },
});

const upload = multer({ storage });

// --- Transcription route ---
app.post("/api/transcribe", upload.single("audio"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: "No audio file" });

    const audioPath = path.resolve(req.file.path);
    const audioBuffer = fs.readFileSync(audioPath);

    console.log("Sending audio to Deepgram...");

    const { result, error } = await deepgram.listen.prerecorded.transcribeFile(
      audioBuffer,
      {
        model: "nova-2",
        smart_format: true,
        mimetype: req.file.mimetype,
      }
    );

    if (error) throw error;

    const transcript =
      result.results?.channels[0]?.alternatives[0]?.transcript || "";

    console.log("Transcription:", transcript);

    // --- Save transcription to Supabase ---
    const { data, error: dbError } = await supabase
      .from("transcriptions")
      .insert([{ filename: req.file.filename, transcription: transcript }])
      .select();

    if (dbError) {
      console.error("Database insert error:", dbError.message);
    } else {
      console.log("Saved transcription to Supabase:", data);
    }

    // Send response to frontend
    res.json({
      message: "Transcription successful",
      filename: req.file.filename,
      transcript,
    });

    // Optional: delete uploaded file to keep uploads folder clean
    fs.unlinkSync(audioPath);
  } catch (err) {
    console.error("Transcription error:", err);
    res.status(500).json({
      message: "Transcription failed",
      error: err.message,
    });
  }
});

// --- Fetch all transcriptions route ---
app.get("/api/transcriptions", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("transcriptions")
      .select("*")
      .order("created_at", { ascending: false });

    if (error) throw error;

    res.json(data);
  } catch (err) {
    console.error("Error fetching transcriptions:", err.message);
    res.status(500).json({ message: err.message });
  }
});

// --- Start the server ---
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
