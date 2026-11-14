// OpenCL for ggml-opencl, from the phone's own libOpenCL.so, opened on first use:
// linked against it instead, this library would not load at all where there is
// none (most phones but Snapdragons), and Turbo would not run even on the CPU.
// Where it cannot be opened, clGetPlatformIDs finds no platform, so ggml has no
// OpenCL device; nothing else is called then.
//
// The functions ggml-opencl calls (llvm-nm -u libggml-opencl.a), as the Khronos
// headers declare them (fetch-whisper.sh); a newer whisper.cpp calling one more
// fails to link, and it goes here the same way.

#define CL_TARGET_OPENCL_VERSION 300
#include <CL/cl.h>
#include <CL/cl_ext.h>
#include <dlfcn.h>
#include <stddef.h>

static void *find(const char *name) {
    static void *lib;
    if (!lib) lib = dlopen("libOpenCL.so", RTLD_NOW | RTLD_LOCAL);
    return lib ? dlsym(lib, name) : NULL;
}

cl_int CL_API_CALL clBuildProgram(cl_program program, cl_uint num_devices, const cl_device_id * device_list, const char * options, void (CL_CALLBACK * pfn_notify)(cl_program program, void * user_data), void * user_data) {
    static cl_int (CL_API_CALL *f)(cl_program program, cl_uint num_devices, const cl_device_id * device_list, const char * options, void (CL_CALLBACK * pfn_notify)(cl_program program, void * user_data), void * user_data);
    if (!f && !(f = find("clBuildProgram"))) {
        return CL_INVALID_OPERATION;
    }
    return f(program, num_devices, device_list, options, pfn_notify, user_data);
}

cl_mem CL_API_CALL clCreateBuffer(cl_context context, cl_mem_flags flags, size_t size, void * host_ptr, cl_int * errcode_ret) {
    static cl_mem (CL_API_CALL *f)(cl_context context, cl_mem_flags flags, size_t size, void * host_ptr, cl_int * errcode_ret);
    if (!f && !(f = find("clCreateBuffer"))) {
        if (errcode_ret) *errcode_ret = CL_INVALID_OPERATION;
        return NULL;
    }
    return f(context, flags, size, host_ptr, errcode_ret);
}

cl_mem CL_API_CALL clCreateBufferWithProperties(cl_context context, const cl_mem_properties * properties, cl_mem_flags flags, size_t size, void * host_ptr, cl_int * errcode_ret) {
    static cl_mem (CL_API_CALL *f)(cl_context context, const cl_mem_properties * properties, cl_mem_flags flags, size_t size, void * host_ptr, cl_int * errcode_ret);
    if (!f && !(f = find("clCreateBufferWithProperties"))) {
        if (errcode_ret) *errcode_ret = CL_INVALID_OPERATION;
        return NULL;
    }
    return f(context, properties, flags, size, host_ptr, errcode_ret);
}

cl_command_queue CL_API_CALL clCreateCommandQueue(cl_context context, cl_device_id device, cl_command_queue_properties properties, cl_int * errcode_ret) {
    static cl_command_queue (CL_API_CALL *f)(cl_context context, cl_device_id device, cl_command_queue_properties properties, cl_int * errcode_ret);
    if (!f && !(f = find("clCreateCommandQueue"))) {
        if (errcode_ret) *errcode_ret = CL_INVALID_OPERATION;
        return NULL;
    }
    return f(context, device, properties, errcode_ret);
}

cl_context CL_API_CALL clCreateContext(const cl_context_properties * properties, cl_uint num_devices, const cl_device_id * devices, void (CL_CALLBACK * pfn_notify)(const char * errinfo, const void * private_info, size_t cb, void * user_data), void * user_data, cl_int * errcode_ret) {
    static cl_context (CL_API_CALL *f)(const cl_context_properties * properties, cl_uint num_devices, const cl_device_id * devices, void (CL_CALLBACK * pfn_notify)(const char * errinfo, const void * private_info, size_t cb, void * user_data), void * user_data, cl_int * errcode_ret);
    if (!f && !(f = find("clCreateContext"))) {
        if (errcode_ret) *errcode_ret = CL_INVALID_OPERATION;
        return NULL;
    }
    return f(properties, num_devices, devices, pfn_notify, user_data, errcode_ret);
}

cl_mem CL_API_CALL clCreateImage(cl_context context, cl_mem_flags flags, const cl_image_format * image_format, const cl_image_desc * image_desc, void * host_ptr, cl_int * errcode_ret) {
    static cl_mem (CL_API_CALL *f)(cl_context context, cl_mem_flags flags, const cl_image_format * image_format, const cl_image_desc * image_desc, void * host_ptr, cl_int * errcode_ret);
    if (!f && !(f = find("clCreateImage"))) {
        if (errcode_ret) *errcode_ret = CL_INVALID_OPERATION;
        return NULL;
    }
    return f(context, flags, image_format, image_desc, host_ptr, errcode_ret);
}

cl_kernel CL_API_CALL clCreateKernel(cl_program program, const char * kernel_name, cl_int * errcode_ret) {
    static cl_kernel (CL_API_CALL *f)(cl_program program, const char * kernel_name, cl_int * errcode_ret);
    if (!f && !(f = find("clCreateKernel"))) {
        if (errcode_ret) *errcode_ret = CL_INVALID_OPERATION;
        return NULL;
    }
    return f(program, kernel_name, errcode_ret);
}

cl_program CL_API_CALL clCreateProgramWithBinary(cl_context context, cl_uint num_devices, const cl_device_id * device_list, const size_t * lengths, const unsigned char ** binaries, cl_int * binary_status, cl_int * errcode_ret) {
    static cl_program (CL_API_CALL *f)(cl_context context, cl_uint num_devices, const cl_device_id * device_list, const size_t * lengths, const unsigned char ** binaries, cl_int * binary_status, cl_int * errcode_ret);
    if (!f && !(f = find("clCreateProgramWithBinary"))) {
        if (errcode_ret) *errcode_ret = CL_INVALID_OPERATION;
        return NULL;
    }
    return f(context, num_devices, device_list, lengths, binaries, binary_status, errcode_ret);
}

cl_program CL_API_CALL clCreateProgramWithSource(cl_context context, cl_uint count, const char ** strings, const size_t * lengths, cl_int * errcode_ret) {
    static cl_program (CL_API_CALL *f)(cl_context context, cl_uint count, const char ** strings, const size_t * lengths, cl_int * errcode_ret);
    if (!f && !(f = find("clCreateProgramWithSource"))) {
        if (errcode_ret) *errcode_ret = CL_INVALID_OPERATION;
        return NULL;
    }
    return f(context, count, strings, lengths, errcode_ret);
}

cl_mem CL_API_CALL clCreateSubBuffer(cl_mem buffer, cl_mem_flags flags, cl_buffer_create_type buffer_create_type, const void * buffer_create_info, cl_int * errcode_ret) {
    static cl_mem (CL_API_CALL *f)(cl_mem buffer, cl_mem_flags flags, cl_buffer_create_type buffer_create_type, const void * buffer_create_info, cl_int * errcode_ret);
    if (!f && !(f = find("clCreateSubBuffer"))) {
        if (errcode_ret) *errcode_ret = CL_INVALID_OPERATION;
        return NULL;
    }
    return f(buffer, flags, buffer_create_type, buffer_create_info, errcode_ret);
}

cl_int CL_API_CALL clEnqueueBarrierWithWaitList(cl_command_queue command_queue, cl_uint num_events_in_wait_list, const cl_event * event_wait_list, cl_event * event) {
    static cl_int (CL_API_CALL *f)(cl_command_queue command_queue, cl_uint num_events_in_wait_list, const cl_event * event_wait_list, cl_event * event);
    if (!f && !(f = find("clEnqueueBarrierWithWaitList"))) {
        return CL_INVALID_OPERATION;
    }
    return f(command_queue, num_events_in_wait_list, event_wait_list, event);
}

cl_int CL_API_CALL clEnqueueCopyBuffer(cl_command_queue command_queue, cl_mem src_buffer, cl_mem dst_buffer, size_t src_offset, size_t dst_offset, size_t size, cl_uint num_events_in_wait_list, const cl_event * event_wait_list, cl_event * event) {
    static cl_int (CL_API_CALL *f)(cl_command_queue command_queue, cl_mem src_buffer, cl_mem dst_buffer, size_t src_offset, size_t dst_offset, size_t size, cl_uint num_events_in_wait_list, const cl_event * event_wait_list, cl_event * event);
    if (!f && !(f = find("clEnqueueCopyBuffer"))) {
        return CL_INVALID_OPERATION;
    }
    return f(command_queue, src_buffer, dst_buffer, src_offset, dst_offset, size, num_events_in_wait_list, event_wait_list, event);
}

cl_int CL_API_CALL clEnqueueFillBuffer(cl_command_queue command_queue, cl_mem buffer, const void * pattern, size_t pattern_size, size_t offset, size_t size, cl_uint num_events_in_wait_list, const cl_event * event_wait_list, cl_event * event) {
    static cl_int (CL_API_CALL *f)(cl_command_queue command_queue, cl_mem buffer, const void * pattern, size_t pattern_size, size_t offset, size_t size, cl_uint num_events_in_wait_list, const cl_event * event_wait_list, cl_event * event);
    if (!f && !(f = find("clEnqueueFillBuffer"))) {
        return CL_INVALID_OPERATION;
    }
    return f(command_queue, buffer, pattern, pattern_size, offset, size, num_events_in_wait_list, event_wait_list, event);
}

void * CL_API_CALL clEnqueueMapBuffer(cl_command_queue command_queue, cl_mem buffer, cl_bool blocking_map, cl_map_flags map_flags, size_t offset, size_t size, cl_uint num_events_in_wait_list, const cl_event * event_wait_list, cl_event * event, cl_int * errcode_ret) {
    static void * (CL_API_CALL *f)(cl_command_queue command_queue, cl_mem buffer, cl_bool blocking_map, cl_map_flags map_flags, size_t offset, size_t size, cl_uint num_events_in_wait_list, const cl_event * event_wait_list, cl_event * event, cl_int * errcode_ret);
    if (!f && !(f = find("clEnqueueMapBuffer"))) {
        if (errcode_ret) *errcode_ret = CL_INVALID_OPERATION;
        return NULL;
    }
    return f(command_queue, buffer, blocking_map, map_flags, offset, size, num_events_in_wait_list, event_wait_list, event, errcode_ret);
}

cl_int CL_API_CALL clEnqueueMarkerWithWaitList(cl_command_queue command_queue, cl_uint num_events_in_wait_list, const cl_event * event_wait_list, cl_event * event) {
    static cl_int (CL_API_CALL *f)(cl_command_queue command_queue, cl_uint num_events_in_wait_list, const cl_event * event_wait_list, cl_event * event);
    if (!f && !(f = find("clEnqueueMarkerWithWaitList"))) {
        return CL_INVALID_OPERATION;
    }
    return f(command_queue, num_events_in_wait_list, event_wait_list, event);
}

cl_int CL_API_CALL clEnqueueNDRangeKernel(cl_command_queue command_queue, cl_kernel kernel, cl_uint work_dim, const size_t * global_work_offset, const size_t * global_work_size, const size_t * local_work_size, cl_uint num_events_in_wait_list, const cl_event * event_wait_list, cl_event * event) {
    static cl_int (CL_API_CALL *f)(cl_command_queue command_queue, cl_kernel kernel, cl_uint work_dim, const size_t * global_work_offset, const size_t * global_work_size, const size_t * local_work_size, cl_uint num_events_in_wait_list, const cl_event * event_wait_list, cl_event * event);
    if (!f && !(f = find("clEnqueueNDRangeKernel"))) {
        return CL_INVALID_OPERATION;
    }
    return f(command_queue, kernel, work_dim, global_work_offset, global_work_size, local_work_size, num_events_in_wait_list, event_wait_list, event);
}

cl_int CL_API_CALL clEnqueueReadBuffer(cl_command_queue command_queue, cl_mem buffer, cl_bool blocking_read, size_t offset, size_t size, void * ptr, cl_uint num_events_in_wait_list, const cl_event * event_wait_list, cl_event * event) {
    static cl_int (CL_API_CALL *f)(cl_command_queue command_queue, cl_mem buffer, cl_bool blocking_read, size_t offset, size_t size, void * ptr, cl_uint num_events_in_wait_list, const cl_event * event_wait_list, cl_event * event);
    if (!f && !(f = find("clEnqueueReadBuffer"))) {
        return CL_INVALID_OPERATION;
    }
    return f(command_queue, buffer, blocking_read, offset, size, ptr, num_events_in_wait_list, event_wait_list, event);
}

cl_int CL_API_CALL clEnqueueUnmapMemObject(cl_command_queue command_queue, cl_mem memobj, void * mapped_ptr, cl_uint num_events_in_wait_list, const cl_event * event_wait_list, cl_event * event) {
    static cl_int (CL_API_CALL *f)(cl_command_queue command_queue, cl_mem memobj, void * mapped_ptr, cl_uint num_events_in_wait_list, const cl_event * event_wait_list, cl_event * event);
    if (!f && !(f = find("clEnqueueUnmapMemObject"))) {
        return CL_INVALID_OPERATION;
    }
    return f(command_queue, memobj, mapped_ptr, num_events_in_wait_list, event_wait_list, event);
}

cl_int CL_API_CALL clEnqueueWriteBuffer(cl_command_queue command_queue, cl_mem buffer, cl_bool blocking_write, size_t offset, size_t size, const void * ptr, cl_uint num_events_in_wait_list, const cl_event * event_wait_list, cl_event * event) {
    static cl_int (CL_API_CALL *f)(cl_command_queue command_queue, cl_mem buffer, cl_bool blocking_write, size_t offset, size_t size, const void * ptr, cl_uint num_events_in_wait_list, const cl_event * event_wait_list, cl_event * event);
    if (!f && !(f = find("clEnqueueWriteBuffer"))) {
        return CL_INVALID_OPERATION;
    }
    return f(command_queue, buffer, blocking_write, offset, size, ptr, num_events_in_wait_list, event_wait_list, event);
}

cl_int CL_API_CALL clFinish(cl_command_queue command_queue) {
    static cl_int (CL_API_CALL *f)(cl_command_queue command_queue);
    if (!f && !(f = find("clFinish"))) {
        return CL_INVALID_OPERATION;
    }
    return f(command_queue);
}

cl_int CL_API_CALL clFlush(cl_command_queue command_queue) {
    static cl_int (CL_API_CALL *f)(cl_command_queue command_queue);
    if (!f && !(f = find("clFlush"))) {
        return CL_INVALID_OPERATION;
    }
    return f(command_queue);
}

cl_int CL_API_CALL clGetDeviceIDs(cl_platform_id platform, cl_device_type device_type, cl_uint num_entries, cl_device_id * devices, cl_uint * num_devices) {
    static cl_int (CL_API_CALL *f)(cl_platform_id platform, cl_device_type device_type, cl_uint num_entries, cl_device_id * devices, cl_uint * num_devices);
    if (!f && !(f = find("clGetDeviceIDs"))) {
        return CL_INVALID_OPERATION;
    }
    return f(platform, device_type, num_entries, devices, num_devices);
}

cl_int CL_API_CALL clGetDeviceInfo(cl_device_id device, cl_device_info param_name, size_t param_value_size, void * param_value, size_t * param_value_size_ret) {
    static cl_int (CL_API_CALL *f)(cl_device_id device, cl_device_info param_name, size_t param_value_size, void * param_value, size_t * param_value_size_ret);
    if (!f && !(f = find("clGetDeviceInfo"))) {
        return CL_INVALID_OPERATION;
    }
    return f(device, param_name, param_value_size, param_value, param_value_size_ret);
}

cl_int CL_API_CALL clGetKernelSubGroupInfo(cl_kernel kernel, cl_device_id device, cl_kernel_sub_group_info param_name, size_t input_value_size, const void* input_value, size_t param_value_size, void* param_value, size_t* param_value_size_ret) {
    static cl_int (CL_API_CALL *f)(cl_kernel kernel, cl_device_id device, cl_kernel_sub_group_info param_name, size_t input_value_size, const void* input_value, size_t param_value_size, void* param_value, size_t* param_value_size_ret);
    if (!f && !(f = find("clGetKernelSubGroupInfo"))) {
        return CL_INVALID_OPERATION;
    }
    return f(kernel, device, param_name, input_value_size, input_value, param_value_size, param_value, param_value_size_ret);
}

cl_int CL_API_CALL clGetKernelWorkGroupInfo(cl_kernel kernel, cl_device_id device, cl_kernel_work_group_info param_name, size_t param_value_size, void * param_value, size_t * param_value_size_ret) {
    static cl_int (CL_API_CALL *f)(cl_kernel kernel, cl_device_id device, cl_kernel_work_group_info param_name, size_t param_value_size, void * param_value, size_t * param_value_size_ret);
    if (!f && !(f = find("clGetKernelWorkGroupInfo"))) {
        return CL_INVALID_OPERATION;
    }
    return f(kernel, device, param_name, param_value_size, param_value, param_value_size_ret);
}

cl_int CL_API_CALL clGetPlatformIDs(cl_uint num_entries, cl_platform_id * platforms, cl_uint * num_platforms) {
    static cl_int (CL_API_CALL *f)(cl_uint num_entries, cl_platform_id * platforms, cl_uint * num_platforms);
    if (!f && !(f = find("clGetPlatformIDs"))) {
        return CL_PLATFORM_NOT_FOUND_KHR;
    }
    return f(num_entries, platforms, num_platforms);
}

cl_int CL_API_CALL clGetPlatformInfo(cl_platform_id platform, cl_platform_info param_name, size_t param_value_size, void * param_value, size_t * param_value_size_ret) {
    static cl_int (CL_API_CALL *f)(cl_platform_id platform, cl_platform_info param_name, size_t param_value_size, void * param_value, size_t * param_value_size_ret);
    if (!f && !(f = find("clGetPlatformInfo"))) {
        return CL_INVALID_OPERATION;
    }
    return f(platform, param_name, param_value_size, param_value, param_value_size_ret);
}

cl_int CL_API_CALL clGetProgramBuildInfo(cl_program program, cl_device_id device, cl_program_build_info param_name, size_t param_value_size, void * param_value, size_t * param_value_size_ret) {
    static cl_int (CL_API_CALL *f)(cl_program program, cl_device_id device, cl_program_build_info param_name, size_t param_value_size, void * param_value, size_t * param_value_size_ret);
    if (!f && !(f = find("clGetProgramBuildInfo"))) {
        return CL_INVALID_OPERATION;
    }
    return f(program, device, param_name, param_value_size, param_value, param_value_size_ret);
}

cl_int CL_API_CALL clGetProgramInfo(cl_program program, cl_program_info param_name, size_t param_value_size, void * param_value, size_t * param_value_size_ret) {
    static cl_int (CL_API_CALL *f)(cl_program program, cl_program_info param_name, size_t param_value_size, void * param_value, size_t * param_value_size_ret);
    if (!f && !(f = find("clGetProgramInfo"))) {
        return CL_INVALID_OPERATION;
    }
    return f(program, param_name, param_value_size, param_value, param_value_size_ret);
}

cl_int CL_API_CALL clReleaseEvent(cl_event event) {
    static cl_int (CL_API_CALL *f)(cl_event event);
    if (!f && !(f = find("clReleaseEvent"))) {
        return CL_INVALID_OPERATION;
    }
    return f(event);
}

cl_int CL_API_CALL clReleaseKernel(cl_kernel kernel) {
    static cl_int (CL_API_CALL *f)(cl_kernel kernel);
    if (!f && !(f = find("clReleaseKernel"))) {
        return CL_INVALID_OPERATION;
    }
    return f(kernel);
}

cl_int CL_API_CALL clReleaseMemObject(cl_mem memobj) {
    static cl_int (CL_API_CALL *f)(cl_mem memobj);
    if (!f && !(f = find("clReleaseMemObject"))) {
        return CL_INVALID_OPERATION;
    }
    return f(memobj);
}

cl_int CL_API_CALL clReleaseProgram(cl_program program) {
    static cl_int (CL_API_CALL *f)(cl_program program);
    if (!f && !(f = find("clReleaseProgram"))) {
        return CL_INVALID_OPERATION;
    }
    return f(program);
}

cl_int CL_API_CALL clSetKernelArg(cl_kernel kernel, cl_uint arg_index, size_t arg_size, const void * arg_value) {
    static cl_int (CL_API_CALL *f)(cl_kernel kernel, cl_uint arg_index, size_t arg_size, const void * arg_value);
    if (!f && !(f = find("clSetKernelArg"))) {
        return CL_INVALID_OPERATION;
    }
    return f(kernel, arg_index, arg_size, arg_value);
}

cl_int CL_API_CALL clWaitForEvents(cl_uint num_events, const cl_event * event_list) {
    static cl_int (CL_API_CALL *f)(cl_uint num_events, const cl_event * event_list);
    if (!f && !(f = find("clWaitForEvents"))) {
        return CL_INVALID_OPERATION;
    }
    return f(num_events, event_list);
}
