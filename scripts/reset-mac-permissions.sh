#!/bin/bash

# Bundle ID from electron-builder.yml
BUNDLE_ID="com.gemmasight.app"

echo "--------------------------------------------------------"
echo "MacOS Privacy Permissions Reset Tool"
echo "Target: $BUNDLE_ID"
echo "--------------------------------------------------------"

# ScreenCapture
echo "Restoring Screen Recording permission..."
tccutil reset ScreenCapture $BUNDLE_ID

# Microphone
echo "Restoring Microphone permission..."
tccutil reset Microphone $BUNDLE_ID

# Camera
echo "Restoring Camera permission..."
tccutil reset Camera $BUNDLE_ID

echo "--------------------------------------------------------"
echo "Done! Please follow these steps next:"
echo "1. Quit the application if it is running."
echo "2. Open System Settings > Privacy & Security > Screen Recording."
echo "3. Remove any remaining 'GemmaSight' entries (using the minus button)."
echo "4. Restart the application and grant permissions when prompted."
echo "--------------------------------------------------------"
