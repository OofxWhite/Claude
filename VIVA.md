# VIVA.md — Single-Company Enquiry Booking System

## 1. Project Aim

A production-quality web application that lets customers of a single company register an account, browse real appointment availability on an interactive calendar, submit an enquiry for a specific date and time, and optionally receive an automated email reminder before their appointment. The company's staff manage bookings and availability through a role-gated admin area.

This is a university project. The goal was correct functionality, a clean architecture that's easy to explain in a viva, reasonable security, and a demo-ready deployment — not enterprise scale.

## 2. Main Features

- **Authentication**: email/password registration and login, hashed passwords, signed session cookies, protected routes.
- **Interactive booking wizard**: calendar date picker → time-slot grid → enquiry details (auto-filled from the account) → reminder opt-in → confirmation screen with a reference code.
- **Customer dashboard**: upcoming/past bookings, reminder status, self-service cancellation.
- **Admin area**: overview stats, a searchable table of all bookings with a detail view and cancel action, and a weekly-availability + blocked-dates manager.
- **Server-side reminder system**: a scheduled job (not a browser timer) that emails a reminder before each appointment, with duplicate-send protection.
- **Dark/light theme**: toggle in the header, persisted, respects system preference, no flash of the wrong theme on load.

## 3. Technical Architecture

| Layer | Choice | Why |
|---|---|---|
| Framework | Next.js 16 (App Router), TypeScript, Turbopack | One framework for both UI and API/backend logic |
| Database | PostgreSQL (Supabase free tier) | Real relational DB with constraints, needed for race-condition-safe booking |
| ORM | Prisma 6.19 (not 7) | Prisma 7 replaced the simple `datasource.url` schema syntax with a driver-adapter/`prisma.config.ts` pattern; 6.x keeps the classic, widely-documented pattern that's simpler to explain and matches most course material |
| Auth | Auth.js (NextAuth) v5, Credentials provider, JWT session strategy | No separate session table needed; the signed cookie carries user id/role/phone |
| UI | Tailwind CSS v4 + shadcn/ui ("base" preset, built on Base UI primitives instead of Radix) | Accessible components, CSS-variable theming out of the box |
| Email | Resend | Simple API, generous free tier |
| Reminders | Vercel Cron → `/api/cron/reminders` | Server-side, works with zero long-running processes, fits serverless hosting |
| Validation | Zod (shared schemas for client + server) | Single source of truth for form rules |
| Testing | Vitest | Fast, TypeScript-native, no extra config for this scope |

Routes are protected by `src/proxy.ts` (Next.js 16 renamed "middleware" to "proxy" — the file was written and later renamed to follow that convention), which redirects unauthenticated users to `/login` and non-admins away from `/admin/*`. Every admin API route *also* re-checks the session role itself (`requireAdminSession()` in `src/lib/admin-guard.ts`), so authorization does not depend on the proxy alone.

## 4. Database Design

```
User            id, name, email (unique), phone, passwordHash, role (CUSTOMER|ADMIN), timestamps
Booking         id, reference (public-facing, e.g. "ENQ-7F3A9C2B"), userId → User,
                scheduledAt (UTC), durationMinutes, status (CONFIRMED|CANCELLED),
                activeSlotKey (nullable, unique), subject, message,
                reminderRequested, reminderScheduledAt, reminderSent, reminderSentAt, timestamps
AvailabilityRule id, dayOfWeek (0-6), startMinutes, endMinutes, slotDurationMinutes, isActive
BlockedDate      id, date ("YYYY-MM-DD", unique), reason
```

Available slots for a given date are **computed on read** from `AvailabilityRule` + `BlockedDate` + existing `CONFIRMED` bookings, rather than pre-generating and storing every future slot as a row. This keeps admin configuration simple (a handful of rule rows instead of thousands of slot rows) and guarantees the calendar UI and the booking API always agree, since both call the same `getSlotsForDate()` function in `src/lib/availability.ts`.

**Double-booking prevention**: `Booking.activeSlotKey` mirrors `scheduledAt` while a booking is `CONFIRMED`, and is set to `null` on cancellation. It carries a database-level `UNIQUE` constraint. Postgres treats `NULL` as distinct from every other value in a unique index, so a cancelled booking's row no longer blocks that slot, while two *simultaneously* confirmed bookings for the same instant are impossible — the second `INSERT` fails with a unique-constraint violation (Prisma error `P2002`), which the API turns into a friendly "that slot was just taken" response. This was verified with an automated test that fires two concurrent `create()` calls at the same slot and asserts exactly one succeeds.

## 5. Authentication

- Passwords are hashed with `bcryptjs` (cost factor 12) before storage; plaintext passwords are never persisted or logged.
- Auth.js's Credentials provider looks up the user by email and compares the hash in its `authorize()` callback.
- Sessions use the JWT strategy: a signed, httpOnly cookie holds `{ id, role, phone }`, verified server-side on every request. No server-side session store is needed.
- `src/proxy.ts` blocks unauthenticated access to `/book`, `/dashboard`, `/admin`; admin routes additionally check `role === "ADMIN"`.
- Every mutating API route re-derives the session from the request itself — nothing trusts a client-supplied user id.

## 6. Booking Process

1. **Date** — `Calendar` (react-day-picker under the hood) fetches which weekdays have any active `AvailabilityRule` and which specific dates are blocked, then disables past dates, non-configured weekdays, and blocked dates.
2. **Time** — fetches `getSlotsForDate(date)` and renders each slot as available / selected / booked / past, using distinct, non-"disabled-looking" styling for available slots per the brief.
3. **Details** — subject + message; name/email/phone are pulled from the session, not re-entered.
4. **Reminder** — a toggle; the copy changes if the appointment is under 24 hours away.
5. **Confirmation** — on submit, the server re-validates availability (never trusting the client), creates the booking inside the unique-constraint-guarded insert described above, sends a confirmation email, and returns a reference code, which the wizard displays alongside the formatted date/time and reminder status.

## 7. Reminder System

`computeReminderScheduledAt()` (`src/lib/reminder.ts`):
- Normal case: appointment time minus 24 hours.
- If the booking is made less than 24 hours before the appointment (so "24 hours before" would already be in the past), it schedules the reminder 5 minutes after booking instead — as long as that's still meaningfully before the appointment.
- If the appointment is essentially immediate, no separate reminder is scheduled (the confirmation email already covers it).

`/api/cron/reminders` (invoked by Vercel Cron every 10 minutes, protected by a `CRON_SECRET` bearer token):
- Finds `CONFIRMED` bookings with `reminderRequested && !reminderSent && reminderScheduledAt <= now`.
- **Atomically claims** each one via `updateMany({ where: { id, reminderSent: false }, data: { reminderSent: true } })` before sending — so two overlapping cron runs can never both send the same reminder (only one `updateMany` call can "win" the `reminderSent: false` condition).
- If sending fails, the claim is rolled back so the next run retries.
- Cancelled bookings are excluded by the `status: "CONFIRMED"` filter — a cancelled booking's reminder is never sent, verified in testing.

## 8. Email Integration

Resend, via `src/lib/email.ts`. If `RESEND_API_KEY` isn't set, sending is skipped with a console warning rather than crashing — useful for local development without an email account, but a real deployment needs a real key (see `.env.example`).

## 9. Security

- Hashed passwords (bcrypt), never logged or returned by any API.
- Signed JWT session cookies; no sensitive data in client-side JS beyond what's needed to render (name/email/role).
- Server-side authorization on every mutating route: booking cancellation checks `booking.userId === session.user.id`; every admin route checks `role === "ADMIN"` independently of the route-protecting proxy.
- All input validated with Zod on the server (not just the client) before touching the database.
- Public booking references (`ENQ-XXXXXXXX`) are shown to users instead of internal database ids.
- Cron endpoint requires a bearer-token secret.
- `.env` is gitignored; `.env.example` documents every variable with no real secrets committed.

## 10. UI / Theme Implementation

Tailwind v4 + shadcn/ui, with all colours expressed as CSS custom properties (`--background`, `--primary`, etc.) redefined under a `.dark` class rather than hard-coded per component. `next-themes` toggles that class, persists the choice, and defaults to the OS preference on first visit; because it injects its own pre-hydration script, there's no flash of the wrong theme.

## 11. Deployment

Target: **Vercel** (app) + **Supabase** (Postgres). Steps:
1. Push the repository to GitHub and import it into Vercel.
2. Set the environment variables listed in `.env.example` in the Vercel project settings.
3. Run `npx prisma migrate deploy` (or let a build step run it) against the production database.
4. `vercel.json` already declares the cron job that drives reminders — Vercel wires it up automatically on deploy and injects the `CRON_SECRET` bearer token for you as long as that env var is set.

## 12. Testing

`npm test` runs the Vitest suite (`npx vitest run`):
- **Unit tests** for the pure logic: reminder-scheduling rules, Zod validation schemas, timezone conversion (including a DST-crossing case), and 12/24-hour label formatting.
- **Integration tests** against the real (Supabase) database: availability computation for weekday/weekend/past dates, and — the most important one — firing two simultaneous `Booking.create()` calls at the identical slot and asserting exactly one succeeds while the other hits the unique-constraint violation, plus that cancelling frees the slot again.

Manually walked through and verified in a real browser against the live dev server: registration, login, the full 5-step booking wizard, the customer dashboard (including cancellation), the admin overview/bookings/availability pages (including adding a blocked date and confirming it disables that date on the customer calendar), the reminder cron endpoint's auth guard and its atomic-claim/rollback behaviour, and that a non-admin is blocked from `/admin` both by the page redirect and by a direct 403 from the admin API.

`npm run lint`, `npx tsc --noEmit`, and `npm run build` all pass cleanly.

## 13. Technical Decisions Worth Explaining

- **Prisma 6 over 7**: chosen deliberately after `prisma generate` failed against the newly-installed Prisma 7, which requires a driver-adapter config pattern. 6.x is simpler to explain and still fully supported.
- **Computed availability instead of a pre-generated slots table**: avoids a huge, hard-to-administer table of future slot rows; the tradeoff is a slightly more involved read-time computation, which is cheap at this scale.
- **`activeSlotKey` nullable-unique trick**: lets the database itself guarantee exclusivity without hand-rolled locking, while still allowing a cancelled slot to be rebooked (Postgres unique indexes ignore `NULL`s).
- **JWT sessions over database sessions**: simpler schema, no session table to prune, and sufficient for this scale; the tradeoff is that revoking a session before its JWT expires isn't instant (acceptable for a university project's threat model).
- **shadcn's "base" (Base UI) preset instead of Radix**: functionally similar; the generated components use a `render` prop pattern instead of Radix's `asChild`, which is what shows up throughout the component code.

## 14. Problems Encountered and Solutions

- **Node.js wasn't installed on the dev machine** — installed via `winget install OpenJS.NodeJS.LTS`; discovered that newly-spawned shells/processes didn't pick up the updated `PATH` within the same session, so subsequent commands explicitly prepended the Node install directory to `PATH`.
- **`prisma generate` failed on Prisma 7** with a schema-validation error about `datasource.url` no longer being supported — resolved by pinning to the last Prisma 6.x release (6.19.3), which keeps the traditional schema syntax.
- **Supabase connection string had a literal `[YOUR-PASSWORD]` placeholder** (Supabase never shows the real password in that field) — resolved by resetting the database password (which is shown once) and substituting it in manually.
- **A genuine bug caught by the automated test suite, not by manual testing**: `getSlotsForDate()` computed the end of a day by asking for "24:00" as a time-of-day, which is not a valid time string — the timezone parser silently collapsed it to the same instant as "00:00", making the day's booked-slots query always return zero rows regardless of what was actually booked. In effect, an already-booked slot would never show as "Booked" to a second customer (it would still be correctly rejected at final submission by the database's unique constraint, but the UI wouldn't have warned them beforehand). Fixed by deriving the exclusive end-of-day bound as `dayStart + 24 hours` instead. This is a good example of why the concurrency/availability tests were worth writing: it passed every manual click-through because manual testing never re-opened the time picker for an already-booked date.
- **A shadcn/Base UI composition bug**: `DropdownMenuLabel` (Base UI's `Menu.GroupLabel`) throws at runtime if it isn't wrapped in `<Menu.Group>`, unlike the equivalent Radix component — this crashed the account menu on the customer dashboard. Fixed by wrapping it in `DropdownMenuGroup`.
- **Console warnings about `nativeButton`** whenever a `Button` was composed with a `render` prop pointing at a `<Link>` (Base UI expects to be told explicitly that it isn't rendering a real `<button>`) — fixed once, centrally, inside the shared `Button` component rather than at every call site.
- **The Supabase free-tier pooler occasionally dropped a connection** mid-session during development (`P1001: Can't reach database server`), which resolved itself on the very next request. Documented as a known limitation rather than engineered around, since it's a free-tier characteristic rather than an application bug.

## 15. Limitations

- No automated end-to-end (browser) test runner is wired into `npm test` — the golden path was verified manually in a real browser rather than with Playwright, to keep the toolchain smaller for this scope.
- Cancelling and rebooking is unlimited; there's no rate limiting on booking creation or login attempts.
- The reminder cron interval (10 minutes) means a reminder can fire up to ~10 minutes after its exact scheduled time; acceptable for an appointment reminder, not acceptable for anything time-critical.
- Session revocation isn't instant (JWT-based sessions remain valid until they expire, even if e.g. an admin is later demoted).
- Single company, single timezone, single "resource" (one appointment at a time) — intentionally not modelled for multiple staff/services, per the brief.

## 16. Potential Viva Questions

- *How do you guarantee two customers can't book the same slot at the same time?* — the `activeSlotKey` unique database constraint; walk through the nullable-unique trick and the concurrency test.
- *Why not just check availability in the application code before inserting?* — a check-then-insert has a race window between the two operations; only a database constraint is atomic across concurrent requests.
- *How are passwords protected?* — bcrypt hashing, cost factor 12, never stored or logged in plaintext.
- *What happens if the reminder email fails to send?* — the atomic claim is rolled back, so the next cron run retries it; explain the `updateMany` claim pattern.
- *How do you stop a customer from viewing someone else's booking?* — every query is scoped to `session.user.id`; there's no route that accepts an arbitrary booking id without that check.
- *How do you stop a non-admin from reaching the admin API directly (bypassing the UI)?* — every admin route calls `requireAdminSession()` itself, independent of the route-protecting proxy; demonstrate the 403 response.
- *Why Prisma 6 and not 7?* — explain the driver-adapter change and the simplicity tradeoff for this project's scope.
- *How is the reminder timing decided for last-minute bookings?* — walk through `computeReminderScheduledAt`'s three cases.
- *What's stored in the session cookie, and is it safe?* — a signed JWT with id/role/phone; it's httpOnly and signed with `AUTH_SECRET`, so it can't be read or forged by client-side JS.
