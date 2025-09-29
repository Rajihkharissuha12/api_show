// server/index.js
const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server: SocketIOServer } = require("socket.io");
const {
  ThermalPrinter,
  PrinterTypes,
  CharacterSet,
  BreakLine,
} = require("node-thermal-printer");

const PORT = process.env.PORT || 4000;

const allowedOrigins = [
  "http://localhost:3000",
  "https://api-show-46cu.vercel.app",
  "https://www.api-show-46cu.vercel.app",
];

const app = express();
app.use(express.json());
app.use(
  cors({
    origin: allowedOrigins,
    credentials: false, // set true bila perlu cookie
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  })
);

const httpServer = http.createServer(app);

const io = new SocketIOServer(httpServer, {
  cors: {
    origin: allowedOrigins,
    credentials: false,
    methods: ["GET", "POST"],
  },
  transports: ["polling", "websocket"],
  pingTimeout: 60000,
  pingInterval: 25000,
  maxHttpBufferSize: 1e7,
  // path: "/socket.io", // default; ubah jika dibutuhkan
});

// Point system
const ITEM_POINTS = {
  APEL: 20,
  JERUK: 15,
  PISANG: 10,
  MANGGA: 25,
  DEFAULT: 10,
};

// In-memory sessions
const activeSessions = new Map();

io.on("connection", (socket) => {
  console.log(`🔌 Client connected: ${socket.id}`);

  socket.emit("welcome", {
    message: "Connected to Express Socket.IO",
    socketId: socket.id,
  });

  socket.on("session:start", (data) => {
    const sessionId = data?.sessionId || `session_${socket.id}_${Date.now()}`;
    const newSession = {
      id: sessionId,
      items: {},
      totalItems: 0,
      totalPoints: 0,
      startTime: Date.now(),
      socketId: socket.id,
      active: true,
    };
    activeSessions.set(sessionId, newSession);

    console.log(`📝 Session started: ${sessionId}`);

    io.emit("session:started", {
      sessionId,
      timestamp: Date.now(),
      message: "New scan session started",
    });

    socket.emit("session:confirmed", { sessionId, status: "active" });
  });

  socket.on("scan:result", (data) => {
    const { sessionId, itemName, quantity = 1 } = data || {};
    if (!sessionId || !itemName) {
      socket.emit("error", { message: "Invalid payload", sessionId, itemName });
      return;
    }

    const session = activeSessions.get(sessionId);
    if (!session) {
      socket.emit("error", { message: "Session not found", sessionId });
      return;
    }

    const key = String(itemName).toUpperCase();
    const perItem = ITEM_POINTS[key] || ITEM_POINTS.DEFAULT;
    const addPoints = perItem * quantity;

    if (session.items[key]) {
      session.items[key].quantity += quantity;
      session.items[key].totalPoints += addPoints;
    } else {
      session.items[key] = {
        name: key,
        quantity,
        pointsPerItem: perItem,
        totalPoints: addPoints,
        lastScanned: new Date().toISOString(),
      };
    }

    session.totalItems = Object.values(session.items).reduce(
      (s, it) => s + it.quantity,
      0
    );
    session.totalPoints = Object.values(session.items).reduce(
      (s, it) => s + it.totalPoints,
      0
    );
    session.lastUpdate = Date.now();

    io.emit("scan:update", {
      sessionId,
      item: session.items[key],
      session: {
        totalItems: session.totalItems,
        totalPoints: session.totalPoints,
        items: session.items,
        lastUpdate: session.lastUpdate,
      },
    });

    // Broadcast ringkas untuk homepage
    io.emit("inventory:update", {
      sessionId,
      itemName: key,
      quantity: session.items[key].quantity,
      lastUpdate: session.lastUpdate,
    });

    socket.emit("scan:confirmed", {
      success: true,
      item: session.items[key],
      totalPoints: session.totalPoints,
    });
  });

  socket.on("quantity:adjust", (data) => {
    const { sessionId, itemName, delta } = data || {};
    const session = activeSessions.get(sessionId);
    const key = String(itemName || "").toUpperCase();

    if (!session || !session.items[key]) {
      socket.emit("error", {
        message: "Session or item not found",
        sessionId,
        itemName: key,
      });
      return;
    }

    const item = session.items[key];
    const newQty = Math.max(0, item.quantity + delta);

    if (newQty === 0) {
      delete session.items[key];
    } else {
      item.quantity = newQty;
      item.totalPoints = item.pointsPerItem * newQty;
      item.lastScanned = new Date().toISOString();
    }

    session.totalItems = Object.values(session.items).reduce(
      (s, it) => s + it.quantity,
      0
    );
    session.totalPoints = Object.values(session.items).reduce(
      (s, it) => s + it.totalPoints,
      0
    );
    session.lastUpdate = Date.now();

    io.emit("quantity:updated", {
      sessionId,
      itemName: key,
      newQuantity: newQty,
      session: {
        totalItems: session.totalItems,
        totalPoints: session.totalPoints,
        items: session.items,
        lastUpdate: session.lastUpdate,
      },
    });

    io.emit("inventory:update", {
      sessionId,
      itemName: key,
      quantity: newQty,
      lastUpdate: session.lastUpdate,
    });
  });

  socket.on("session:finish", (data) => {
    const sessionId = data?.sessionId;
    const session = activeSessions.get(sessionId);
    if (!session) {
      socket.emit("error", { message: "Session not found" });
      return;
    }

    const summary = {
      sessionId,
      totalItems: session.totalItems,
      totalPoints: session.totalPoints,
      items: session.items,
      duration: Date.now() - session.startTime,
      finishedAt: Date.now(),
    };

    io.emit("session:finished", { summary });
    io.emit("inventory:reset", { sessionId });

    session.active = false;

    setTimeout(() => {
      activeSessions.delete(sessionId);
      console.log(`🗑️ Session cleaned up: ${sessionId}`);
    }, 30000);
  });

  socket.on("ping", () => socket.emit("pong", { timestamp: Date.now() }));

  socket.on("disconnect", (reason) => {
    console.log(`🔌 Client disconnected: ${socket.id} (${reason})`);
  });

  socket.on("error", (err) => {
    console.error(`❌ Socket error from ${socket.id}:`, err);
  });
});

app.get("/", (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
      <head>
        <title>Welcome Event</title>
        <style>
          body {
            display: flex;
            justify-content: center;
            align-items: center;
            height: 100vh;
            margin: 0;
            background-color:rgb(126, 56, 56);
            font-family: Arial, sans-serif;
          }
          h1 {
            font-size: 3rem;
            color: #333;
          }
        </style>
      </head>
      <body>
        <h1>Welcome Service Event Infinix</h1>
      </body>
    </html>
  `);
});

httpServer.listen(PORT, () => {
  console.log(`✅ Express Socket.IO listening on http://localhost:${PORT}`);
});
