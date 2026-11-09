<?php
// Lab assertion surface only; the chain targets /index.php so this script's
// output never participates in the heap calibration.
echo "PHP ", PHP_VERSION, "\n";
echo "MEMORY_LIMIT ", ini_get('memory_limit'), "\n";
echo "DISPLAY_ERRORS ", ini_get('display_errors'), "\n";
echo "OUTPUT_BUFFERING ", ini_get('output_buffering'), "\n";
echo "LOG_ERRORS ", ini_get('log_errors'), "\n";
echo "UPLOAD_PROGRESS ", ini_get('session.upload_progress.enabled'), "\n";
