# The Turbo model's runtime (Whisper.java): whisper.cpp (scripts/fetch-whisper.sh)
# on the CPU, and on the GPU through Vulkan where the phone's passes its check
# (TurboGpu), linked into one library with turbo.c. Built for arm64-v8a with dot
# products and half floats, which every phone it is offered on has (Turbo.supported
# checks), and nothing older.
cmake_minimum_required(VERSION 3.22)
project(ivritturbo C CXX)

# Vulkan can be left out (gradle -PturboVulkan=OFF): the CPU only, then.
option(IVRIT_TURBO_VULKAN "the Turbo model on the GPU too, through Vulkan" ON)

foreach(dir whisper.cpp vulkan-headers spirv-headers)
    if(NOT EXISTS ${CMAKE_CURRENT_SOURCE_DIR}/${dir})
        message(FATAL_ERROR "${dir} is missing: run scripts/fetch-whisper.sh")
    endif()
endforeach()

set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)
set(WHISPER_BUILD_TESTS OFF CACHE BOOL "" FORCE)
set(WHISPER_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
set(WHISPER_BUILD_SERVER OFF CACHE BOOL "" FORCE)
set(WHISPER_ALL_WARNINGS OFF CACHE BOOL "" FORCE)
set(GGML_NATIVE OFF CACHE BOOL "" FORCE)
set(GGML_OPENMP OFF CACHE BOOL "" FORCE)
set(GGML_CPU_ARM_ARCH "armv8.2-a+dotprod+fp16" CACHE STRING "" FORCE)

# Vulkan: the headers fetched (the NDK's are too old for ggml), the NDK's loader
# library and shader compiler. ggml-vulkan's shader generator is built for this
# machine, with its own compiler, as ggml arranges when cross-compiling.
set(GGML_VULKAN ${IVRIT_TURBO_VULKAN} CACHE BOOL "" FORCE)
if(IVRIT_TURBO_VULKAN)
    set(Vulkan_INCLUDE_DIR ${CMAKE_CURRENT_SOURCE_DIR}/vulkan-headers/include CACHE PATH "" FORCE)
    # ggml needs Vulkan 1.1, whose functions Android's loader exports from Android 9
    # (API 28) on: linked against that, so on older phones (the app goes back to 7)
    # this library does not load, and Turbo is not offered (Turbo.supported).
    if(NOT ANDROID_ABI STREQUAL "arm64-v8a")
        message(FATAL_ERROR "the Turbo model is built for arm64-v8a only")
    endif()
    set(Vulkan_LIBRARY ${CMAKE_SYSROOT}/usr/lib/aarch64-linux-android/28/libvulkan.so CACHE FILEPATH "" FORCE)
    file(GLOB GLSLC ${ANDROID_NDK}/shader-tools/*/glslc)
    set(Vulkan_GLSLC_EXECUTABLE ${GLSLC} CACHE FILEPATH "" FORCE)
    # ggml asks for SPIR-V's headers as an installed package; they are only headers.
    set(SPIRV_CONFIG ${CMAKE_CURRENT_BINARY_DIR}/spirv-headers-config)
    file(WRITE ${SPIRV_CONFIG}/SPIRV-HeadersConfig.cmake "")
    set(SPIRV-Headers_DIR ${SPIRV_CONFIG} CACHE PATH "" FORCE)
endif()

add_subdirectory(whisper.cpp)
if(IVRIT_TURBO_VULKAN)
    target_include_directories(ggml-vulkan PRIVATE ${Vulkan_INCLUDE_DIR} ${CMAKE_CURRENT_SOURCE_DIR}/spirv-headers/include)
endif()

add_library(ivritturbo SHARED turbo.c guard.cpp)
target_link_libraries(ivritturbo PRIVATE whisper ggml log)
target_compile_options(ivritturbo PRIVATE -O3)
target_link_options(ivritturbo PRIVATE -Wl,--gc-sections -Wl,--exclude-libs,ALL)
