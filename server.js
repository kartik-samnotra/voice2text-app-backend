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

// ✅ FIXED CORS CONFIGURATION
app.use(cors({
  origin: [
    "http://localhost:5173",
    "https://voice2text-frontend.netlify.app",
    "https://voice2text-frontend.netlify.app/",
    "https://*.netlify.app"
  ],
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "Accept"]
}));

// Handle preflight requests
app.options("*", cors());

app.use(express.json());

// Add request logging middleware
app.use((req, res, next) => {
  console.log(`📨 ${new Date().toISOString()} ${req.method} ${req.url}`);
  console.log(`   Origin: ${req.headers.origin}`);
  console.log(`   User-Agent: ${req.headers['user-agent']}`);
  next();
});

// ... rest of your server.js code remains the same

// --- Validate keys early ---
if (!process.env.DEEPGRAM_API_KEY) {
  console.error("❌ Missing DEEPGRAM_API_KEY in environment. Set process.env.DEEPGRAM_API_KEY");
}
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error("❌ Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in environment. Set them in .env");
}

// ✅ Use the SERVICE ROLE KEY (not the anon key!)
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Deepgram setup
const deepgram = Deepgram.createClient(process.env.DEEPGRAM_API_KEY);

// --- Multer disk storage (for uploaded audio files) ---
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadPath = "uploads/";
    if (!fs.existsSync(uploadPath)) {
      fs.mkdirSync(uploadPath, { recursive: true });
    }
    cb(null, uploadPath);
  },
  filename: (req, file, cb) => {
    cb(null, `${Date.now()}-${file.originalname}`);
  },
});
const upload = multer({ storage });

// --- Helper to safely delete a file ---
const safeUnlink = (filePath) => {
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch (e) {
    console.error("Failed to delete file:", filePath, e.message);
  }
};

// --- POST /api/transcribe ---
app.post("/api/transcribe", upload.single("audio"), async (req, res) => {
  const file = req.file;
  if (!file) {
    return res
      .status(400)
      .json({ message: "No audio file in request (field name must be 'audio')." });
  }

  try {
    // --- Step 1: Validate Supabase JWT ---
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      safeUnlink(file.path);
      return res
        .status(401)
        .json({ message: "Missing Authorization header (Bearer <token> required)." });
    }
    const token = authHeader.split(" ")[1];
    if (!token) {
      safeUnlink(file.path);
      return res.status(401).json({ message: "Malformed Authorization header." });
    }

    const { data: userData, error: userErr } = await supabase.auth.getUser(token);
    if (userErr || !userData?.user) {
      safeUnlink(file.path);
      console.error("Supabase token error:", userErr?.message || "no user returned");
      return res.status(401).json({ message: "Invalid or expired auth token." });
    }
    const user = userData.user;

    // --- Step 2: Prepare audio file ---
    const audioPath = path.resolve(file.path);
    const stat = fs.statSync(audioPath);
    console.log(
      `Received file: ${audioPath} (${stat.size} bytes), mimetype: ${file.mimetype}`
    );

    const fileStream = fs.createReadStream(audioPath);
    const dgOptions = {
      model: "nova-2",
      smart_format: true,
    };

    console.log("Sending audio stream to Deepgram with options:", dgOptions);

    // --- Step 3: Send to Deepgram ---
    let dgResponse;
    try {
      const { result, error } = await deepgram.listen.prerecorded.transcribeFile(
        fileStream,
        dgOptions
      );
      if (error) {
        console.error("Deepgram returned an error object:", error);
        throw new Error(error.message || "Deepgram returned an error");
      }
      dgResponse = result;
    } catch (dgErr) {
      console.error("Deepgram SDK error:", dgErr?.message || dgErr);
      safeUnlink(audioPath);
      return res.status(502).json({
        message: "Deepgram transcription failed.",
        error: dgErr?.message || String(dgErr),
      });
    }

    // --- Step 4: Extract transcript safely ---
    let transcript = "";
    try {
      transcript =
        dgResponse?.results?.channels?.[0]?.alternatives?.[0]?.transcript ||
        dgResponse?.results?.channels?.[0]?.alternatives
          ?.map((a) => a.transcript)
          .join(" ") ||
        "";
    } catch (e) {
      console.warn("Could not parse Deepgram response properly.");
    }

    console.log(
      "Deepgram transcription result (truncated):",
      transcript ? transcript.slice(0, 200) : "<empty>"
    );

    // --- Step 5: Save transcription to Supabase ---
    const { data: dbData, error: dbError } = await supabase
      .from("transcriptions")
      .insert([
        {
          filename: file.filename,
          transcription: transcript,
          user_id: user.id, // ✅ crucial for RLS
        },
      ])
      .select();

    if (dbError) {
      console.error("Supabase insert error:", dbError.message);
      safeUnlink(audioPath);
      return res
        .status(500)
        .json({ message: "Failed to save transcription to DB.", error: dbError.message });
    }

    console.log(
      "✅ Saved transcription to Supabase for user:",
      user.id,
      "record:",
      dbData?.[0]?.id
    );

    safeUnlink(audioPath);

    return res.json({
      message: "Transcription successful",
      transcript,
      filename: file.filename,
      user_id: user.id,
    });
  } catch (err) {
    console.error("Unexpected server error in /api/transcribe:", err?.message || err);
    if (req.file?.path) safeUnlink(req.file.path);
    return res
      .status(500)
      .json({ message: "Internal server error", error: err?.message || String(err) });
  }
});

// --- GET /api/transcriptions ---
app.get("/api/transcriptions", async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader)
      return res.status(401).json({ message: "Missing Authorization header." });

    const token = authHeader.split(" ")[1];
    if (!token) return res.status(401).json({ message: "Malformed Authorization header." });

    const { data: userData, error: userErr } = await supabase.auth.getUser(token);
    if (userErr || !userData?.user) {
      console.error("Supabase getUser error:", userErr?.message || "no user");
      return res.status(401).json({ message: "Invalid or expired auth token." });
    }
    const user = userData.user;

    const { data, error } = await supabase
      .from("transcriptions")
      .select("*")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false });

    if (error) {
      console.error("Supabase select error:", error.message);
      return res.status(500).json({ message: "Failed to fetch transcriptions." });
    }

    return res.json(data);
  } catch (err) {
    console.error("Unexpected server error in /api/transcriptions:", err?.message || err);
    return res
      .status(500)
      .json({ message: "Internal server error", error: err?.message || String(err) });
  }
});

// --- Start Server ---
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
