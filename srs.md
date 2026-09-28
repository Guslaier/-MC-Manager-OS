# เอกสารข้อกำหนดความต้องการซอฟต์แวร์ (Software Requirements Specification - SRS)

**ชื่อโครงการ:** Standalone Minecraft Server Manager (TypeScript Full-Stack / runc Edition)
**เวอร์ชัน:** 8.0 (Final - Locked Tech Stack & Production Ready)

---

## 1. บทนำ (Introduction)

### 1.1 วัตถุประสงค์ (Purpose)
เอกสารฉบับนี้กำหนดความต้องการและสถาปัตยกรรมของแอปพลิเคชัน Web-based Control Panel สำหรับจัดการเซิร์ฟเวอร์ Minecraft รูปแบบ Standalone (โหลดไฟล์เดียวรันได้ทันทีโดยไม่ต้องติดตั้ง Node.js หรือ Docker ล่วงหน้า) มุ่งเน้นการใช้งานแบบส่วนตัว (Single-User) มีความปลอดภัยระดับ Sandbox ผ่านการจำลอง Container และถูกพัฒนาด้วย **TypeScript** ทั้งระบบเพื่อความเสถียรสูงสุด

### 1.2 ขอบเขตของระบบ (Project Scope)
แอปพลิเคชันถูกเขียนด้วย TypeScript ทั้งระบบ (Node.js + React.js) แพ็กเป็นไฟล์ Executable (`.exe` สำหรับ Windows และ `.elf` สำหรับ Linux) ระบบตรวจจับ OS อัตโนมัติเพื่อเลือกโหมดการทำงาน (WSL2 หรือ Native) ใช้ `runc` เป็น Container Engine โดยยึดหลัก **"1 เซิร์ฟเวอร์ ต่อ 1 Container"** มีฟังก์ชันจัดการไฟล์, Live Console, จำกัดทรัพยากร, รองรับซอฟต์แวร์กำหนดเอง (Custom `.jar` / `.sh`) และมีระบบถอนการติดตั้งที่สะอาดหมดจด 100%

---

## 2. ภาพรวมและสถาปัตยกรรม (System Architecture)

ระบบใช้ **Smart OS Detection** เพื่อปรับโครงสร้างตามระบบปฏิบัติการของเครื่อง Host:

### 2.1 โหมด Windows (WSL2 Architecture)
* **Layer 1 - Windows Executable (`.exe`):** ทำหน้าที่ตรวจสอบ WSL2 (ขอสิทธิ์ Admin) และเป็น Web Server
* **Layer 2 - Dedicated OS:** สร้าง Linux จำลองชื่อ `MC-Manager-OS` เพื่อแยกไฟล์ไม่ให้ปะปนกับข้อมูลอื่น
* **Layer 3 - Container Engine:** Backend ใช้ `child_process` ส่งคำสั่งทะลุเข้าไปเรียก `runc` ใน WSL2

### 2.2 โหมด Linux Native (VPS / Dedicated Server Architecture)
* **Layer 1 - Linux Binary (`.elf`):** รันแอปพลิเคชันบน Host OS โดยตรง
* **Layer 2 - Container Engine:** สั่งรัน `runc` แบบ Native (ต้องมี `runc` บน PATH และ kernel ที่เปิด **cgroup v2**; ต้องรันด้วยสิทธิ์ที่เพียงพอ เพราะ `runc` ต้องการ root)
* **Layer 3 - Storage:** เก็บข้อมูลเซิร์ฟเวอร์ทั้งหมดในโฟลเดอร์ซ่อน เช่น `~/.mc-manager/` (ค่าดีฟอลต์บน Linux; `MCM_DATA_DIR` ใช้ override ได้)
* **Environment Variables (Linux):**
  * `MCM_RUNTIME_MODE` = `auto` | `native` (`native` = docker+runc, ไม่ตั้ง = ใช้ host `runc` โดยตรง; ค่า `wsl` เป็น Windows-only และจะถูกปฏิเสธ)
  * `MCM_RUNTIME_MODE=runc` = strict host-`runc` runtime on Linux (explicit request: never falls back to docker or the WSL bridge; refused on Windows). On Linux, `auto` ignores container binaries reached through Windows drive mounts (`/mnt/<drive>/`, e.g. WSL interop exposing `docker.exe`), so host-runc selection stays honest.
  * Production Linux run: `./apps/server/dist/mcm-server-linux` (built by `npm run package:server:linux`); `tsx` is dev-only. That binary is glibc-linked and therefore cannot run inside the musl Alpine `MC-Manager-OS` distro (runc/rootfs host only).
  * Paper integration check: `.roo_lab/verify-paper.sh` (native runc path) drives login -> engine(runc) -> create -> EULA -> canonical `server.jar` upload -> start -> Minecraft handshake ping on `MCM_PAPER_PORT` (default 25565) plus procfs metrics -> stop -> cleanup. The jar is never fetched implicitly: set `MCM_PAPER_JAR`, or opt in with `MCM_PAPER_DOWNLOAD=1` + `MCM_PAPER_URL` (or `MCM_PAPER_VERSION`) + `MCM_PAPER_SHA256`. Without a jar/runtime it hard-SKIPs (exit 79) instead of faking a pass.
  * `MCM_WSL_ROOTFS` = path ของ rootfs template ที่เตรียมไว้บน host (ใช้ร่วมกับโหมด native Linux เพราะ `runc` ไม่มี image store)
  * `MCM_WSL_BUNDLE_DIR` = `/var/lib/mcm/bundles` (ค่าเริ่มต้น), `MCM_WSL_RUNC_ROOT` = `/var/lib/mcm/runc-state` (ค่าเริ่มต้น)
  * ไม่ต้องตั้ง `MCM_DATA_DIR` หากต้องการค่าเริ่มต้น `~/.mc-manager` (ห้ามคัดลอกค่า UNC ของ Windows `.env` มาใช้บน Linux); เซิร์ฟเวอร์จะสร้าง DATA_ROOT ให้เองอัตโนมัติเมื่อเริ่มทำงานครั้งแรกถ้ายังไม่มีโฟลเดอร์
  * `MCM_ALPINE_TAR_URL` / `MCM_ALPINE_SHA256` = ใช้เฉพาะโหมด `--bootstrap-rootfs` เพื่อกำหนดแหล่งและ checksum ของ Alpine minirootfs (ค่า default ของ URL คือ `dl-cdn.alpinelinux.org`; ค่า SHA256 **ต้องระบุเองเสมอ** ไม่งั้นระบบจะปฏิเสธไม่ดาวน์โหลด)
* **Manual Steps (Linux):** ติดตั้ง `runc` ด้วย package manager (`apt-get install runc` / `dnf install runc`) แล้วนำ rootfs (เช่น Alpine minirootfs) มา untar ไว้บน host และตั้ง `MCM_WSL_ROOTFS` ให้ชี้ไปที่โฟลเดอร์นั้น; การดาวน์โหลด/import rootfs อัตโนมัติเป็นขั้นตอนของ Windows/WSL เท่านั้น
* **Java (Linux):** ใช้ JRE ที่ติดตั้งบน host ผ่าน package manager (เช่น `openjdk-17-jre-headless`) - ระบบจะ **ไม่** ติดตั้งอัตโนมัติ; ส่วน REQ-4.2 (`apk add`) ยังคงใช้กับโหมด WSL2/Alpine เท่านั้น
* **Env Files (แยกแพลตฟอร์ม):** `apps/server/load-env.ts` โหลด `.env.<platform>` (`.env.windows` บน win32, `.env.linux` บน Linux) เป็นตัว override ของ `.env` ที่ใช้ร่วมกัน; ตั้ง `MCM_ENV_FILE` เพื่อบังคับไฟล์เดียว (ใช้ escalated `.env` ได้โดยไม่ต้องแก้) ดูตัวอย่างที่ `.env.windows.example` / `.env.linux.example`
* **Setup Command (Linux):** รัน `npm run setup:linux` (เทียบเท่า `npx tsx apps/server/setup-linux.ts --check`) เพื่อ **ตรวจ** prerequisites (Node/npm, `runc`, JRE, cgroup v2, rootfs template, env leak) โดยไม่แก้ไขระบบ; จะติดตั้งแพ็กเกจผ่าน package manager (apt/dnf/yum/apk/pacman/zypper) ให้ก็ต่อเมื่อระบุ `--apply --yes` เท่านั้น; บน Windows คำสั่งนี้จะปฏิเสธตัวเอง (exit 2) และชี้ไปใช้เส้นทาง WSL2 แทน
* **Rootfs Bootstrap (opt-in):** `npx tsx apps/server/setup-linux.ts --bootstrap-rootfs` จะแสดงแผนเท่านั้น (dry-run, ไม่ดาวน์โหลด/ไม่เขียนไฟล์); ต้องใส่ `--apply --yes` จึงจะดาวน์โหลด tarball, ตรวจ SHA256, แล้วแตกไฟล์ลง `MCM_WSL_ROOTFS`; จะ **ปฏิเสธ** (exit 1) ถ้าโฟลเดอร์ rootfs มีข้อมูลอยู่แล้ว และต้องรันด้วยสิทธิ์ root; แตกไฟล์ได้เฉพาะ regular file/directory และทุก entry ถูกจำกัดให้อยู่ในโฟลเดอร์ rootfs เท่านั้น

### 2.3 กลุ่มผู้ใช้งาน (User Classes)
* **Master Admin (Single-User):** ใช้งานส่วนตัว เข้าสู่ระบบด้วย Master Password เพียงชุดเดียว

---

## 3. ความต้องการทางฟังก์ชัน (Functional Requirements)

### 3.1 ระบบติดตั้ง ถอนการติดตั้ง และนำออกข้อมูล (Install, Uninstall & Export)
* **REQ-1.1 (Install, Permissions & Custom WSL Provisioning):** 
  * ระบบต้องตรวจสอบสถานะแกนหลัก WSL ก่อนทำงาน หากยังไม่มี **ระบบจะขอสิทธิ์ Administrator (UAC)**
  * ระบบต้องข้ามการติดตั้ง Default Distro (Ubuntu) โดยใช้คำสั่ง `wsl --install --no-distribution` เพื่อโหลดเฉพาะ Kernel
  * หากเปิดฟีเจอร์สำเร็จ ระบบจะแจ้งเตือนให้ผู้ใช้ Restart เครื่องด้วยตนเอง
  * เมื่อระบบ WSL Engine พร้อมทำงาน แอปจะต้องสร้าง Distro เฉพาะกิจโดยใช้คำสั่ง `wsl --import MC-Manager-OS <Destination> <Path_To_Alpine_Rootfs>`
  * **[เพิ่มใหม่] Engine Provisioning:** ทันทีที่ Import OS จำลองสำเร็จ ระบบ (Wrapper) จะต้องเตรียมความพร้อม Container Engine อัตโนมัติ โดยการสั่งรันคำสั่ง `wsl -d MC-Manager-OS -e apk add --no-cache runc` (หรือดาวน์โหลด Static Binary มาวางใน `/usr/local/bin/runc` และทำ `chmod +x`) เพื่อรับประกันว่า `runc` จะอยู่ใน PATH ของระบบ Linux เสมอ และพร้อมสำหรับการทำ Lifecycle (Start/Stop/Restart/Kill) โดยไม่ติด Error 503
* **REQ-1.2 (Export):** ปุ่ม "Export Data" สำหรับบีบอัดโฟลเดอร์เซิร์ฟเวอร์ (`.zip`) และบันทึกลงเครื่อง Host
* **REQ-1.3 (Uninstall):**
  * แจ้งเตือนให้ผู้ใช้ Export ข้อมูลก่อนเสมอ
  * สั่งหยุด Process (`SIGTERM`) ของทุก Container
  * ลบ `MC-Manager-OS` (บน Windows) หรือโฟลเดอร์ `~/.mc-manager/` (บน Linux) คืนพื้นที่ 100% และลบไฟล์แอปพลิเคชันทิ้ง

### 3.2 ระบบยืนยันตัวตน (Authentication)
* **REQ-2.1:** Single-User Login ด้วย Master Password 
* **REQ-2.2:** ใช้ JWT (JSON Web Token) ตรวจสอบสิทธิ์ API และ WebSocket

### 3.3 ระบบจัดการวัฏจักรเซิร์ฟเวอร์ (1 Server = 1 Container)
* **REQ-3.1:** 1 เซิร์ฟเวอร์สร้าง 1 Container แยกขาดจากกัน Backend สร้างไฟล์ `config.json` ให้ `runc` อัตโนมัติ
* **REQ-3.2:** จำกัด RAM และ CPU ผ่านระบบ Linux Cgroups v2
* **REQ-3.3 (WSL2 Networking & Firewall):** 
  * ใช้ Host Networking โดยระบบฝั่ง Windows จะบังคับสร้าง/แก้ไขไฟล์ `%USERPROFILE%\.wslconfig` ให้เป็นโหมด `networkingMode=mirrored` เพื่อให้พอร์ตของ WSL2 ทะลุมายัง Windows `localhost` ได้ 100%
  * ระบบใช้สิทธิ์ Admin เพื่อเพิ่มกฎ Allow Port (เช่น 25565) บน Windows Defender Firewall อัตโนมัติ
* **REQ-3.4:** สามารถส่งคำสั่ง Start, Stop, Restart และ Force Kill ผ่าน `child_process`

### 3.4 ระบบจัดการซอฟต์แวร์ (Version & Custom Core)
* **REQ-4.1 (Base Rootfs):** ระบบจะต้องดาวน์โหลด **Alpine Linux Mini Rootfs (tar.gz)** จาก URL มาตรฐาน (เช่น `https://dl-cdn.alpinelinux.org/alpine/v3.19/releases/x86_64/`) มาเก็บไว้เป็น Base Template สำหรับรัน `runc`
* ****REQ-4.2 (Java Runtime Provisioning):** เนื่องจากสภาพแวดล้อม Container ใช้ Alpine Linux (musl libc) ระบบจะ **ห้ามดาวน์โหลด JDK แบบมาตรฐาน (glibc)** มาใช้ 
  * ให้ระบบจัดการ Java JRE (Java 8, 17, 21) โดยการใช้คำสั่ง Package Manager ของ Alpine โดยตรง เช่น `wsl -d MC-Manager-OS -e apk add --no-cache openjdk17-jre` 
  * หรือหากใช้ระบบ Portable จะต้องดาวน์โหลดไฟล์ `.tar.gz` ที่ระบุสถาปัตยกรรมเป็น `alpine-linux (musl)` เท่านั้น (เช่น จาก Eclipse Temurin)
* **REQ-4.3 (Custom JAR/Script):** รองรับไฟล์ `.jar` ที่อัปโหลดเอง หรือสคริปต์ `.sh` เป็น Startup Script โดยระบบทำ `chmod +x` ให้สคริปต์อัตโนมัติ
* **REQ-4.4:** มีระบบแจ้งเตือนชัดเจนว่า **ไม่รองรับสคริปต์ `.bat`** เนื่องจากสภาพแวดล้อม Container เป็น Linux

### 3.5 ระบบจัดการไฟล์และ Live Console
* **REQ-5.1:** Web-based File Manager (สร้าง ลบ แก้ไข อัปโหลด) รองรับ Chunk Upload
* **REQ-5.2:** รันไฟล์สคริปต์แบบ Sandbox ภายในขอบเขต Container ของตนเอง
* **REQ-5.3 (Console):** สตรีม Log (`stdout/stderr`) จาก `runc` ไปยัง Frontend ผ่าน WebSocket และรับคำสั่ง (`stdin`) สวนกลับแบบ Real-time

### 3.6 ระบบตรวจสอบทรัพยากร (Resource Monitoring)
* **REQ-6.1:** อ่านค่า CPU Usage (%) และ RAM Usage แบบ Real-time ผ่าน Linux Cgroups v2 ส่งให้หน้าเว็บ

---

## 4. ความต้องการที่ไม่ใช่ฟังก์ชัน (Non-Functional Requirements)

### 4.1 ประสิทธิภาพ (Performance)
* **PER-1:** บน Windows ระบบไฟล์เซิร์ฟเวอร์ต้องทำงานใน Virtual Disk (`ext4.vhdx`) ของ WSL2 ห้าม Mount ทะลุเข้า Drive C: เพื่อป้องกัน I/O Bottleneck
* **PER-2:** การกิน RAM ฝั่ง Manager Process ต้องต่ำกว่า 100MB 

### 4.2 ความปลอดภัย (Security)
* **SEC-1:** เซิร์ฟเวอร์แยกจากกันด้วยกลไก Linux Namespaces ไม่สามารถมองเห็นไฟล์หรือดึงทรัพยากรข้าม Container ได้

---

## 5. เทคโนโลยีและการพัฒนา (Tech Stack Lock)

ระบบพัฒนาในรูปแบบ **Monorepo** เพื่อแชร์ `Interface` ของข้อมูลร่วมกัน โดยมีการกำหนดเทคโนโลยีคงที่ (Locked Stack) ห้ามเปลี่ยนแปลงดังนี้:

* **ภาษาหลัก:** **TypeScript (Strict Mode)**
* **Backend Runtime:** **Node.js**
* **Bundler (Standalone):** **Bun** (`bun build --compile`) สำหรับแพ็ก Backend และ Static Frontend เข้าเป็นไฟล์เดียว
* **API & WebSocket:** **Express.js** + **Socket.io**
* **Container Engine:** **`runc`** 
* **Frontend Framework:** **React.js** (ร่วมกับ Vite)
* **Frontend Routing:** **React Router**
* **State Management:** **Zustand**

---

## 6. โครงสร้างหน้าจอและการออกแบบส่วนติดต่อผู้ใช้ (Frontend Architecture)

### 6.1 โครงสร้างเลย์เอาต์หลัก
* **SPA (Single Page Application):** ใช้ `react-router-dom` ป้องกัน Page Reload เพื่อรักษาการเชื่อมต่อ WebSocket
* **Layout Grid:** Sidebar (ระบบนำทาง), Top Bar (สถานะเซิร์ฟเวอร์ & Power Buttons), Main Content

### 6.2 การใช้ TypeScript ร่วมกับ UI Components
* **หน้า Live Console:** ใช้ไลบรารี **`xterm.js`** พร้อมระบบ Auto-scroll อัจฉริยะ 
* **หน้า File Manager:** ใช้ **`@monaco-editor/react`** สำหรับแก้ไขข้อความ/โค้ด (รองรับ Syntax Highlight)
* **หน้า Dashboard:** ใช้ **`recharts`** ในการวาดกราฟ CPU/RAM แบบเรียลไทม์

### 6.3 การจัดการสถานะ (State Management)
* **Shared Data Contracts:** โฟลเดอร์ `shared/types` เก็บ TypeScript Interface (เช่น `IServerStatus`)
* **Global State:** ใช้ **`zustand`** เพื่อเก็บสถานะเซิร์ฟเวอร์ปัจจุบัน (Server State, Resource Limits) และ Session Token

### 6.4 ระบบ UI Component Library และ Styling
* **CSS Framework:** **Tailwind CSS**
* **UI Components:** ใช้ **Shadcn UI** (อ้างอิงบน Radix UI primitives)
* **Theme:** กำหนดค่าเริ่มต้นเป็น Dark Mode ผ่าน Tailwind classes

### 6.5 การตอบสนองต่อผู้ใช้ (UX Feedback)
* **Type-Safe API Calls:** ใช้ **Axios** ดึงข้อมูลร่วมกับ TypeScript Interfaces
* **Notifications:** ใช้ **`react-hot-toast`** แจ้งเตือนสถานะต่างๆ 
* **Destructive Actions:** ทุกปุ่มที่มีผลกระทบถาวร (ลบไฟล์, Uninstall) จะต้องบังคับแสดง Confirm Dialog เสมอ