# The apps' on-device transcripts as ivrit.ai's server makes them (README.md): one
# static library over whisper.cpp's and ggml's targets, which the project adding
# this directory provides (Android: shell/android/app/src/main/cpp).
add_library(ivritnative STATIC
    transcript/transcript.c
    whisperwords/whisperwords.c
    stablets/stablets.c
    speakers/features.c
    speakers/cluster.c
    speakers/ecapa.cpp)
target_include_directories(ivritnative PUBLIC transcript whisperwords stablets speakers)
# zlib: faster-whisper's compression ratio, which decides its fallback (the system's).
find_package(ZLIB REQUIRED)
target_link_libraries(ivritnative PUBLIC whisper ggml ZLIB::ZLIB)
set_target_properties(ivritnative PROPERTIES C_STANDARD 11 CXX_STANDARD 17)
# The arithmetic as the Python each part ports does it: no fused multiply-adds.
target_compile_options(ivritnative PRIVATE -O3 -ffp-contract=off)
