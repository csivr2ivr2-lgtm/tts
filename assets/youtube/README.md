# YouTube brand assets

`aharon-ai-radio-background.parts.json` references the bundled Base64 JPEG chunks for the Aharon AI Radio live-stream background.

The source image is 854×480 (16:9) and the runtime scales/crops it to the configured stream resolution (1280×720 by default) before the one-time H.264 encode. The chunks are stored as text because the repository editing connector used for this project writes text files; the runtime joins and decodes them entirely in memory, with no temporary image file and no ffmpeg process.

Set `YOUTUBE_BACKGROUND_FILE` only when you want to override the bundled branded background with another PNG/JPEG file.
