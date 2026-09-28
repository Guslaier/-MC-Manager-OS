# MC-Manager-OS

> **Standalone Minecraft Server Manager (TypeScript Full-Stack / runc Edition)**  
> High-performance, web-based control panel for Minecraft servers with true OCI container isolation via `runc` on Windows (WSL2) and Linux Native.

---

## 🌟 Overview

**MC-Manager-OS** is a single-user, standalone Minecraft Server Management platform designed for maximum performance, security, and low resource overhead. Unlike traditional wrappers or heavy Docker-based solutions, MC-Manager-OS manages containers directly through the Open Container Initiative (OCI) runtime (`runc`) following a strict **"1 Server = 1 Container"** isolation model.

### Key Highlights

- **Smart OS Architecture Detection:**
  - **Windows:** Runs a dedicated, lightweight Alpine Linux WSL2 distro (`MC-Manager-OS`) directly interacting with `runc` inside the virtual disk (`ext4.vhdx`), eliminating host I/O bottlenecks.
  - **Linux Native:** Runs on the host OS directly using host `runc` with **cgroup v2** resource management.
- **True Container Sandbox:** Each server gets its own isolated Linux namespaces, rootfs, and resource boundaries (RAM & CPU limits via cgroup v2).
- **Interactive Web Control Panel:**
  - **Live Console:** Interactive real-time console powered by `xterm.js` and WebSockets with bidirectional stdin/stdout streaming.
  - **File Manager:** In-browser file management with Monaco Editor code editing, syntax highlighting, and chunked uploads.
  - **Live Metrics:** Real-time CPU and memory usage graphs powered by `recharts` and cgroup v2 metrics.
  - **Java Provisioning:** Built-in runtime management for Alpine musl JRE (Java 8, 17, 21) or custom JAR/startup scripts.
  - **Single-User Security:** Master password authentication with signed JWT tokens.

---

## 🏗️ Architecture

```
+-------------------------------------------------------------------------+
|                               Browser UI                                |
|           (React 18 + Vite + Tailwind CSS + xterm.js + Monaco)          |
+------------------------------------+------------------------------------+
                                     |  HTTP REST / WebSocket (JWT Auth)
                                     v
+-------------------------------------------------------------------------+
|                        Backend Manager (Node.js)                        |
|                     apps/server (Express + Socket.io)                   |
+------------------------------------+------------------------------------+
                                     |
               +---------------------+---------------------+
               |                                           |
               v (Windows Mode)                            v (Linux Native)
+-------------------------------+           +-------------------------------+
|  Dedicated WSL2 Distro        |           |  Host Linux Environment       |
|  (`MC-Manager-OS` - Alpine)   |           |  (cgroup v2 enabled)          |
|  - runc Engine                |           |  - runc Engine                |
|  - Musl JRE 8 / 17 / 21       |           |  - Host JRE / Custom JRE      |
|  - ext4.vhdx storage root     |           |  - ~/.mc-manager storage root |
+---------------+---------------+           +---------------+---------------+
                |                                           |
                +---------------------+---------------------+
                                      v
                      +-------------------------------+
                      |   1 Server = 1 OCI Container  |
                      |   (runc bundle + config.json) |
                      +-------------------------------+
```

---

## 📁 Repository Structure

This repository is structured as a TypeScript monorepo with npm workspaces:

```
MC-Manager-OS/
├── apps/
│   ├── server/             # Node.js backend (Express, Socket.io, runc engine, WSL bridge)
│   └── web/                # React single page application (Vite, Tailwind, Zustand)
├── packages/
│   └── contracts/          # Shared TypeScript interfaces and type definitions
├── .env.example            # Windows / WSL2 environment configuration template
├── .env.linux.example      # Linux native environment configuration template
├── srs.md                  # Software Requirements Specification (SRS)
├── package.json            # Root workspace package scripts
└── tsconfig.json           # Root TypeScript configuration
```

---

## 🚀 Getting Started

### Prerequisites

#### Windows:
- Windows 10/11 with WSL2 enabled.
- Node.js (v20+ recommended) and npm.
- Administrator privileges for initial WSL distro and network provisioning.

#### Linux:
- Linux kernel with **cgroup v2** unified hierarchy enabled.
- `runc` installed (`apt-get install runc` / `dnf install runc`).
- JRE installed (e.g. `openjdk-17-jre-headless` or `openjdk-21-jre-headless`).
- Root privileges (required by `runc` container management).

---

### Configuration

Copy the appropriate example environment file:

**For Windows / WSL2:**
```powershell
cp .env.example .env.windows
# or copy to .env
```

**For Linux Native:**
```bash
cp .env.linux.example .env.linux
```

Edit the environment file to configure your security credentials:
```ini
# Change these values before starting
MCM_MASTER_PASSWORD=your_secure_master_password
MCM_JWT_SECRET=replace_with_a_random_64_character_hex_string
```

Generate a random secret using Node:
```bash
node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))"
```

---

### Development

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Run backend and frontend concurrently:**
   ```bash
   # Terminal 1: Backend API & WebSocket Server (Port 3001)
   npm run dev:server
   # or: npm start

   # Terminal 2: Frontend Web UI (Port 5173)
   npm run dev:web
   ```

3. **Open the Web Interface:**
   - Web App: `http://localhost:5173`
   - Backend API: `http://localhost:3001`

---

### Available Scripts

| Script | Description |
|---|---|
| `npm run typecheck` | Run TypeScript type checks across all workspaces |
| `npm run build` | Typecheck and build production bundle for `apps/web` |
| `npm run dev:server` | Start backend development server with hot-reload |
| `npm run dev:web` | Start Vite development server for frontend |
| `npm run setup:linux` | Validate Linux host prerequisites (`runc`, cgroup v2, Java) |
| `npm run package:server` | Compile backend executable for Windows |
| `npm run package:server:linux` | Compile standalone Linux binary |
| `npm run migrate` | Check pre-canonical server storage migration plan |
| `npm run migrate:apply` | Execute non-destructive server storage migration |

---

## ⚙️ Environment Variables Reference

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3001` | HTTP and WebSocket server port |
| `NODE_ENV` | `development` | Node environment (`development` / `production`) |
| `MCM_RUNTIME_MODE` | `wsl` (Windows) / `auto` (Linux) | Runtime mode (`wsl`, `auto`, `native`, or `runc`) |
| `MCM_MASTER_PASSWORD` | - | Master password for web panel authentication |
| `MCM_JWT_SECRET` | - | Secret key used for signing JWT authentication tokens |
| `MCM_JWT_TTL_SECONDS` | `43200` (12h) | Session token time-to-live |
| `MCM_DATA_DIR` | `\\wsl.localhost\MC-Manager-OS\server` (Win) / `~/.mc-manager` (Linux) | Root directory storing server instances |
| `MCM_WSL_DISTRO` | `MC-Manager-OS` | Name of the dedicated WSL2 distribution |
| `MCM_WSL_ROOTFS` | `/var/lib/mcm/rootfs` | Path to container rootfs template |
| `MCM_WSL_BUNDLE_DIR` | `/var/lib/mcm/bundles` | Directory storing OCI runtime bundles |
| `MCM_WSL_RUNC_ROOT` | `/var/lib/mcm/runc-state` | Directory for `runc` state tracking |
| `MCM_MAX_UPLOAD_BYTES`| `536870912` (512MB) | Maximum file upload size limit |

---

## 🔒 Security & Sandboxing

- **Network Isolation & Mirrored Mode:** On Windows, WSL2 uses `networkingMode=mirrored` to provide zero-latency port forwarding to `localhost`.
- **Resource Sandboxing:** CPU and memory allocation limits are enforced through Linux kernel cgroups v2, preventing rogue servers from exhausting host resources.
- **Dedicated Filesystem:** Server files live on ext4 filesystem to ensure fast native I/O.
- **Safe Authentication:** Single-user design with cryptographically signed tokens and password verification.

---

## 📄 License

This project is licensed under the [MIT License](LICENSE).
