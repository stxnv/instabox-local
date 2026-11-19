# InstaBox Local

A local VM control panel that runs virtual machines on your own machine with QEMU, exposed through a small Node.js server and a web UI.

## What it does

- Detects host hardware (CPU, RAM, GPU) via `detect.ps1` and writes `specs.js` for the UI.
- Runs a Node.js HTTP server (`server.js`) serving a web dashboard plus a REST API.
- Creates, starts, stops, and deletes QEMU virtual machines (qcow2 disks, cloud-init via `make-cidata.py`).
- Supports instant boot from backing images (overlay disks) and ISO installs.
- Forwards SSH (port 2222+) from host to each VM.
- Captures per-VM serial console output.
- Auto-selects an accelerator (KVM on Linux, WHPX on Windows, TCG fallback).

## Requirements

- Node.js
- QEMU (`qemu-system-x86_64`, `qemu-img`)
- Python 3 + `pycdlib` (for cloud-init ISO generation)
- Windows or Linux

## Usage

1. Run `detect.ps1` (Windows) to generate `specs.js`.
2. Run `setup.bat` (Windows) or `node server.js`, then open the printed URL.
3. Use the UI to create and manage VMs.

## API

- `GET /api/health`, `/api/specs`, `/api/vms`
- `POST /api/vms` `{name, ram, cpu, diskGB, iso}`
- `POST /api/vms/:id/start|stop`
- `DELETE /api/vms/:id`
- `GET /api/vms/:id/console`

## Notes

Prototype build. Not affiliated with instabox.sh.
EOF