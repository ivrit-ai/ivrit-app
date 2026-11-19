# The Turbo model for the browser (turbo.cpp): whisper.cpp with the app's patches
# (the Android app's tree, src/main/cpp/whisper.cpp, scripts/fetch-whisper.sh),
# the shared transcript code, on the browser's WebGPU (Dawn's emdawnwebgpu port),
# one thread (a page that is not cross-origin isolated has none). Built by
# scripts/build-web-turbo.sh into web/turbo/.
cmake_minimum_required(VERSION 3.22)
project(ivritturbo_web C CXX)

set(WHISPER_DIR ${CMAKE_CURRENT_SOURCE_DIR}/../../android/app/src/main/cpp/whisper.cpp)
set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)
set(WHISPER_BUILD_TESTS OFF CACHE BOOL "" FORCE)
set(WHISPER_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
set(WHISPER_BUILD_SERVER OFF CACHE BOOL "" FORCE)
set(WHISPER_WASM_PTHREADS OFF CACHE BOOL "" FORCE)  # patches/whisper-wasm-threads.patch
set(GGML_NATIVE OFF CACHE BOOL "" FORCE)
set(GGML_OPENMP OFF CACHE BOOL "" FORCE)
set(GGML_WEBGPU ON CACHE BOOL "" FORCE)
set(GGML_WEBGPU_JSPI ON CACHE BOOL "" FORCE)
# C++ exceptions as WebAssembly's own, as JSPI wants them (ggml-webgpu's CMakeLists):
# the patch's thrown GPU failures reach turbo.cpp's catch.
set(CMAKE_C_FLAGS "${CMAKE_C_FLAGS} -fwasm-exceptions")
set(CMAKE_CXX_FLAGS "${CMAKE_CXX_FLAGS} -fwasm-exceptions")

add_subdirectory(${WHISPER_DIR} whisper)
add_subdirectory(${CMAKE_CURRENT_SOURCE_DIR}/.. native)

add_executable(turbo turbo.cpp)
target_link_libraries(turbo PRIVATE ivritnative whisper ggml)
set_target_properties(turbo PROPERTIES CXX_STANDARD 17 SUFFIX ".mjs")
target_link_options(turbo PRIVATE
    -sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createTurbo
    -sENVIRONMENT=web,worker
    -sALLOW_MEMORY_GROWTH=1 -sMAXIMUM_MEMORY=4GB -sSTACK_SIZE=8MB
    -lworkerfs.js -sFORCE_FILESYSTEM=1
    "-sEXPORTED_FUNCTIONS=['_malloc','_free','_tw_load','_tw_load_speakers','_tw_transcribe','_tw_stop','_tw_result','_tw_error']"
    "-sEXPORTED_RUNTIME_METHODS=['FS','WORKERFS','UTF8ToString','stringToNewUTF8','HEAPF32']"
    "-sJSPI_EXPORTS=['tw_load','tw_load_speakers','tw_transcribe']"
    -sUSE_ZLIB=1)
