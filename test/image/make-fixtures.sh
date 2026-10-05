#!/bin/sh
# The uploader's side: a full ffmpeg makes every file the matrix feeds the worker.
set -eu
mkdir -p "$1"
cd "$1"

ff() { ffmpeg -hide_banner -loglevel error -y "$@"; }

ff -f lavfi -i testsrc2=size=640x360:rate=30:duration=3 -f lavfi -i sine=duration=3 \
  -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest h264-aac.mp4
ff -f lavfi -i testsrc2=size=640x360:rate=30:duration=3 -f lavfi -i sine=duration=3 \
  -c:v libvpx-vp9 -b:v 300k -c:a libopus -shortest vp9-opus.webm
ff -f lavfi -i testsrc2=size=640x360:rate=30:duration=3 -c:v libvpx -b:v 300k vp8.webm
ff -f lavfi -i testsrc2=size=640x360:rate=30:duration=3 -c:v libx265 -pix_fmt yuv420p -tag:v hvc1 hevc.mp4
ff -f lavfi -i testsrc2=size=640x360:rate=30:duration=3 -c:v libaom-av1 -cpu-used 8 -b:v 200k av1.mp4
ff -f lavfi -i testsrc2=size=640x360:rate=30:duration=3 -c:v libaom-av1 -cpu-used 8 -b:v 200k av1.webm
ff -f lavfi -i testsrc2=size=640x360:rate=30:duration=3 -c:v libx264 -pix_fmt yuv420p h264.mkv
ff -f lavfi -i testsrc2=size=640x360:rate=30:duration=3 -c:v libx264 -pix_fmt yuv420p h264.mov
ff -display_rotation 90 -i h264.mov -c copy rotated.mp4
ff -f lavfi -i testsrc2=size=640x360:rate=30:duration=0.5 -c:v libx264 -pix_fmt yuv420p short.mp4
ff -f lavfi -i testsrc2=size=3840x2160:rate=30:duration=1.2 -c:v libx264 -preset ultrafast -pix_fmt yuv420p 4k-h264.mp4
ff -f lavfi -i testsrc2=size=3840x2160:rate=30:duration=1.2 -c:v libx265 -preset ultrafast -pix_fmt yuv420p 4k-hevc.mp4
ff -f lavfi -i testsrc2=size=640x360:rate=30:duration=3 -c:v libx264 -pix_fmt yuv420p -movflags +faststart faststart.mp4
head -c 60000 faststart.mp4 > head60k.mp4
rm faststart.mp4

# A WebM whose frames change size mid-stream, the kind that grows and shrinks in a chat (GRYT-1664).
ff -f lavfi -i testsrc=size=320x240:rate=24:duration=2 -c:v libvpx-vp9 -b:v 300k part-a.webm
ff -f lavfi -i testsrc2=size=1280x200:rate=24:duration=2 -c:v libvpx-vp9 -b:v 300k part-b.webm
printf "file 'part-a.webm'\nfile 'part-b.webm'\nfile 'part-a.webm'\n" > parts.txt
ff -f concat -safe 0 -i parts.txt -c copy resizing.webm
rm part-a.webm part-b.webm parts.txt
ff -f lavfi -i testsrc2=size=1920x1080:rate=60:duration=15 -f lavfi -i sine=duration=15 \
  -c:v libx264 -preset ultrafast -pix_fmt yuv420p -c:a aac -shortest long-1080p60.mp4

head -c 40000 h264-aac.mp4 > cut40k.mp4
head -c 200000 /dev/urandom > random.mp4
echo "this is not a video" > text.mp4
ff -f lavfi -i testsrc2=size=64x64 -frames:v 1 frame.png
mv frame.png png.mp4
ff -f lavfi -i testsrc2=size=640x360:rate=30:duration=2 -c:v mpeg4 clip.avi
cp clip.avi avi.mp4
ff -f lavfi -i testsrc2=size=640x360:rate=30:duration=2 -c:v flv1 clip.flv
ff -f lavfi -i testsrc2=size=640x360:rate=30:duration=2 -c:v mpeg4 mpeg4.mp4
ls -la
