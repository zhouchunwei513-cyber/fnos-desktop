#!/bin/bash
set -e
cd /workspace/projects/nas-exe
export CSC_IDENTITY_AUTO_DISCOVERY=false
exec npx electron-builder --win portable --x64
