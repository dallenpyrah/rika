# Media inspection

Agents use `view_media` for Workspace images, PDFs, audio, and video up to 25 MiB. PNG, JPEG, GIF, and WebP return image metadata; PDF, MP3, Ogg, WAV, and MP4 use the configured media analyzer and return bounded text.

Paths outside the Workspace, missing or oversized files, unsupported formats, unavailable analysis, and analyzer failures are reported as distinct tool errors. Inspection never changes the source file.
