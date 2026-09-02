# Employee Attendance Management System

**MT- Developer Assignment – Inner Eye Consultancy Services LLP**

A full-stack employee attendance application with employee registration/login, check-in/check-out, working-hours calculation, leave deduction, HR dashboard, employee dashboard and attendance status tracking.

## Technology Stack

- Node.js + Express
- SQLite + better-sqlite3
- HTML5, CSS3 and vanilla JavaScript
- bcryptjs for password hashing
- JWT stored in an HttpOnly cookie for authentication

## Features

### Employee
- Register and log in
- Check in / check out
- Automatic working-hours calculation
- Attendance status: Present, Half Day, Absent, On Leave
- Attendance history
- Submit leave requests
- Leave balance and approved leave deduction

### HR
- Secure HR login
- Dashboard statistics
- Employee attendance by selected date
- Check-in/check-out and working hours visibility
- Approve/reject leave requests
- Leave deduction tracking

## Leave Policy Used in This Demo

The assignment does not specify a leave policy, so this implementation uses a simple **12-day annual leave allowance**. Approved leave days are deducted from the employee's balance. Pending requests do not permanently reduce the balance until HR approves them.

## Setup

1. Install Node.js (LTS).
2. Open a terminal in this project folder.
3. Install dependencies:

```bash
npm install
```

4. Copy `.env.example` to `.env` and set a strong `JWT_SECRET`.
5. Start the application:

```bash
npm start
```

6. Open:

`http://localhost:3000`

The SQLite database is created automatically in the `data/` folder.

## HR Demo Account

- Email: `hr@company.com`
- Password: `Admin@123`

Change this demo password before using the application outside the assignment environment.

## Database

The database schema is provided in `schema.sql`. The application also initializes the schema automatically when the server starts.

## Project Structure

```text
employee-attendance-management-system/
├── public/
│   ├── index.html
│   ├── style.css
│   └── app.js
├── schema.sql
├── server.js
├── package.json
├── .env.example
├── .gitignore
└── README.md
```

## Security Notes

- Passwords are hashed with bcrypt.
- Authentication uses an HttpOnly, SameSite cookie.
- Role-based access control protects HR endpoints.
- User input is validated on the server.
- SQL queries use prepared statements.
