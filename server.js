require("dotenv").config();

const express = require("express");
const path = require("path");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const Database = require("better-sqlite3");
const fs = require("fs");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const JWT_SECRET = process.env.JWT_SECRET || "development-only-change-this-secret";

const dataDir = path.join(__dirname, "data");
fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, "attendance.db"));
db.pragma("foreign_keys = ON");
db.exec(fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8"));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, "public")));

function today() {
  return new Date().toISOString().slice(0, 10);
}

function formatDateTime(date = new Date()) {
  return date.toISOString();
}

function minutesBetween(start, end) {
  if (!start || !end) return 0;
  const diff = new Date(end).getTime() - new Date(start).getTime();
  return Math.max(0, Math.round(diff / 60000));
}

function signUser(user) {
  return jwt.sign(
    { id: user.id, role: user.role, name: user.name, email: user.email },
    JWT_SECRET,
    { expiresIn: "8h" }
  );
}

function auth(req, res, next) {
  try {
    const token = req.cookies.session;
    if (!token) return res.status(401).json({ message: "Please log in." });
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ message: "Session expired. Please log in again." });
  }
}

function requireHR(req, res, next) {
  if (req.user.role !== "hr") {
    return res.status(403).json({ message: "HR access required." });
  }
  next();
}

function leaveBalance(userId) {
  const row = db.prepare(`
    SELECT COALESCE(SUM(days), 0) AS used
    FROM leaves
    WHERE user_id = ? AND status = 'Approved'
  `).get(userId);
  const allowance = 12;
  return { allowance, used: Number(row.used), remaining: Math.max(0, allowance - Number(row.used)) };
}

function seedHR() {
  const existing = db.prepare("SELECT id FROM users WHERE email = ?").get("hr@company.com");
  if (!existing) {
    const hash = bcrypt.hashSync("Admin@123", 10);
    db.prepare("INSERT INTO users(name,email,password_hash,role) VALUES(?,?,?,'hr')")
      .run("HR Administrator", "hr@company.com", hash);
  }
}
seedHR();

app.post("/api/register", (req, res) => {
  const { name, email, password } = req.body;
  if (!name?.trim() || !email?.trim() || !password) {
    return res.status(400).json({ message: "Name, email and password are required." });
  }
  if (password.length < 8) {
    return res.status(400).json({ message: "Password must be at least 8 characters." });
  }

  const normalizedEmail = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
    return res.status(400).json({ message: "Enter a valid email address." });
  }

  try {
    const hash = bcrypt.hashSync(password, 10);
    db.prepare("INSERT INTO users(name,email,password_hash,role) VALUES(?,?,?,'employee')")
      .run(name.trim(), normalizedEmail, hash);
    res.json({ message: "Registration successful. You can now log in." });
  } catch (err) {
    if (String(err.message).includes("UNIQUE")) {
      return res.status(409).json({ message: "An account with this email already exists." });
    }
    res.status(500).json({ message: "Registration failed." });
  }
});

app.post("/api/login", (req, res) => {
  const { email, password } = req.body;
  const user = db.prepare("SELECT * FROM users WHERE email = ?").get(String(email || "").trim().toLowerCase());

  if (!user || !bcrypt.compareSync(String(password || ""), user.password_hash)) {
    return res.status(401).json({ message: "Invalid email or password." });
  }

  const token = signUser(user);
  res.cookie("session", token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 8 * 60 * 60 * 1000
  });

  res.json({ message: "Login successful.", role: user.role });
});

app.post("/api/logout", (req, res) => {
  res.clearCookie("session");
  res.json({ message: "Logged out." });
});

app.get("/api/me", auth, (req, res) => {
  const user = db.prepare("SELECT id,name,email,role,created_at FROM users WHERE id = ?").get(req.user.id);
  res.json({ user, leave: leaveBalance(req.user.id) });
});

app.get("/api/employee/dashboard", auth, (req, res) => {
  const record = db.prepare(`
    SELECT id, work_date, check_in, check_out, status, working_minutes
    FROM attendance WHERE user_id = ? AND work_date = ?
  `).get(req.user.id, today());

  const history = db.prepare(`
    SELECT work_date, check_in, check_out, status, working_minutes
    FROM attendance WHERE user_id = ? ORDER BY work_date DESC LIMIT 15
  `).all(req.user.id);

  res.json({
    today: record || {
      work_date: today(),
      check_in: null,
      check_out: null,
      status: "Absent",
      working_minutes: 0
    },
    history,
    leave: leaveBalance(req.user.id)
  });
});

app.post("/api/attendance/check-in", auth, (req, res) => {
  if (req.user.role !== "employee") return res.status(403).json({ message: "Employee access required." });

  const date = today();
  const existing = db.prepare("SELECT * FROM attendance WHERE user_id = ? AND work_date = ?").get(req.user.id, date);

  if (existing?.check_in) return res.status(400).json({ message: "You have already checked in today." });

  const now = formatDateTime();
  if (existing) {
    db.prepare("UPDATE attendance SET check_in = ?, status = 'Present' WHERE id = ?").run(now, existing.id);
  } else {
    db.prepare(`
      INSERT INTO attendance(user_id,work_date,check_in,status,working_minutes)
      VALUES(?,?,?,'Present',0)
    `).run(req.user.id, date, now);
  }

  res.json({ message: "Check-in recorded successfully." });
});

app.post("/api/attendance/check-out", auth, (req, res) => {
  if (req.user.role !== "employee") return res.status(403).json({ message: "Employee access required." });

  const record = db.prepare("SELECT * FROM attendance WHERE user_id = ? AND work_date = ?")
    .get(req.user.id, today());

  if (!record?.check_in) return res.status(400).json({ message: "Please check in first." });
  if (record.check_out) return res.status(400).json({ message: "You have already checked out today." });

  const checkout = formatDateTime();
  const minutes = minutesBetween(record.check_in, checkout);
  const status = minutes >= 480 ? "Present" : "Half Day";

  db.prepare(`
    UPDATE attendance SET check_out = ?, working_minutes = ?, status = ?
    WHERE id = ?
  `).run(checkout, minutes, status, record.id);

  res.json({ message: "Check-out recorded successfully." });
});

app.post("/api/leaves", auth, (req, res) => {
  if (req.user.role !== "employee") return res.status(403).json({ message: "Employee access required." });

  const { startDate, endDate, reason } = req.body;
  if (!startDate || !endDate || endDate < startDate) {
    return res.status(400).json({ message: "Enter a valid leave date range." });
  }

  const start = new Date(`${startDate}T00:00:00`);
  const end = new Date(`${endDate}T00:00:00`);
  const days = Math.floor((end - start) / 86400000) + 1;

  if (days <= 0 || days > 30) return res.status(400).json({ message: "Leave duration must be between 1 and 30 days." });

  const balance = leaveBalance(req.user.id);
  const pending = db.prepare(`
    SELECT COALESCE(SUM(days),0) AS days FROM leaves
    WHERE user_id = ? AND status = 'Pending'
  `).get(req.user.id).days;

  if (days + balance.used + Number(pending) > balance.allowance) {
    return res.status(400).json({ message: `Insufficient leave balance. Remaining: ${balance.remaining} day(s).` });
  }

  db.prepare(`
    INSERT INTO leaves(user_id,start_date,end_date,days,reason,status)
    VALUES(?,?,?,?,?,'Pending')
  `).run(req.user.id, startDate, endDate, days, String(reason || "").trim());

  res.json({ message: "Leave request submitted to HR." });
});

app.get("/api/hr/dashboard", auth, requireHR, (req, res) => {
  const employeeCount = db.prepare("SELECT COUNT(*) AS count FROM users WHERE role='employee'").get().count;
  const todayPresent = db.prepare(`
    SELECT COUNT(*) AS count FROM attendance
    WHERE work_date = ? AND status IN ('Present','Half Day')
  `).get(today()).count;
  const todayOnLeave = db.prepare(`
    SELECT COUNT(*) AS count FROM attendance WHERE work_date = ? AND status = 'On Leave'
  `).get(today()).count;
  const pendingLeaves = db.prepare("SELECT COUNT(*) AS count FROM leaves WHERE status='Pending'").get().count;

  const employees = db.prepare(`
    SELECT u.id,u.name,u.email,
      COALESCE(a.status,'Absent') AS status,
      a.check_in,a.check_out,COALESCE(a.working_minutes,0) AS working_minutes
    FROM users u
    LEFT JOIN attendance a ON a.user_id = u.id AND a.work_date = ?
    WHERE u.role='employee'
    ORDER BY u.name
  `).all(today());

  const leaves = db.prepare(`
    SELECT l.id,l.start_date,l.end_date,l.days,l.reason,l.status,u.name,u.email
    FROM leaves l JOIN users u ON u.id=l.user_id
    ORDER BY CASE l.status WHEN 'Pending' THEN 0 ELSE 1 END, l.created_at DESC
    LIMIT 50
  `).all();

  res.json({
    stats: { employeeCount, todayPresent, todayOnLeave, pendingLeaves },
    employees,
    leaves
  });
});

app.post("/api/hr/leaves/:id/status", auth, requireHR, (req, res) => {
  const { status } = req.body;
  if (!["Approved", "Rejected"].includes(status)) {
    return res.status(400).json({ message: "Invalid leave status." });
  }

  const leave = db.prepare("SELECT * FROM leaves WHERE id = ?").get(req.params.id);
  if (!leave) return res.status(404).json({ message: "Leave request not found." });

  if (status === "Approved") {
    const balance = leaveBalance(leave.user_id);
    if (leave.days > balance.remaining) {
      return res.status(400).json({ message: "Cannot approve: employee does not have enough leave balance." });
    }

    const tx = db.transaction(() => {
      db.prepare("UPDATE leaves SET status='Approved' WHERE id=?").run(leave.id);

      const start = new Date(`${leave.start_date}T00:00:00`);
      for (let i = 0; i < leave.days; i++) {
        const d = new Date(start);
        d.setDate(start.getDate() + i);
        const date = d.toISOString().slice(0,10);
        const existing = db.prepare("SELECT id FROM attendance WHERE user_id=? AND work_date=?")
          .get(leave.user_id, date);

        if (existing) {
          db.prepare("UPDATE attendance SET status='On Leave' WHERE id=?").run(existing.id);
        } else {
          db.prepare(`
            INSERT INTO attendance(user_id,work_date,status,working_minutes)
            VALUES(?,?,'On Leave',0)
          `).run(leave.user_id, date);
        }
      }
    });
    tx();
  } else {
    db.prepare("UPDATE leaves SET status='Rejected' WHERE id=?").run(leave.id);
  }

  res.json({ message: `Leave request ${status.toLowerCase()}.` });
});

app.get("/api/hr/attendance", auth, requireHR, (req, res) => {
  const date = String(req.query.date || today());
  const rows = db.prepare(`
    SELECT u.name,u.email,a.work_date,a.check_in,a.check_out,
      COALESCE(a.status,'Absent') AS status,COALESCE(a.working_minutes,0) AS working_minutes
    FROM users u
    LEFT JOIN attendance a ON a.user_id=u.id AND a.work_date=?
    WHERE u.role='employee'
    ORDER BY u.name
  `).all(date);
  res.json({ date, rows });
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`Employee Attendance Management System running at http://localhost:${PORT}`);
});
