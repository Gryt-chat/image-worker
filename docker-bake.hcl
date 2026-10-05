# CI's two builds: the worker image, and the test image on top of it. The ffmpeg, dav1d and
# SVT-AV1 stages are pinned by hash, so CI caches them instead of compiling them every run.
target "worker" {
  context = "."
  tags = ["gryt-ff-worker"]
}

target "test" {
  context = "test/image"
  contexts = { "gryt-ff-worker" = "target:worker" }
  tags = ["gryt-ff-worker-test"]
}
