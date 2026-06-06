const std = @import("std");

const NativeSource = struct {
    name: []const u8,
    path: []const u8,
};

const native_sources = [_]NativeSource{
    .{ .name = "collab_engine", .path = "native/collab_engine.zig" },
    .{ .name = "composer_policy", .path = "native/composer_policy.zig" },
    .{ .name = "fs_engine", .path = "native/fs_engine.zig" },
    .{ .name = "image_engine", .path = "native/image_engine.zig" },
    .{ .name = "thread_engine", .path = "native/thread_engine.zig" },
};

pub fn build(b: *std.Build) !void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});
    const bench_optimize = b.option(
        std.builtin.OptimizeMode,
        "bench-optimize",
        "Optimization mode for native benchmark executable",
    ) orelse .ReleaseFast;

    const native_step = b.step("native", "Build Bun-loadable native dynamic libraries");
    const test_step = b.step("test", "Run native Zig tests");

    for (native_sources) |source| {
        const root_module = b.createModule(.{
            .root_source_file = b.path(source.path),
            .target = target,
            .optimize = optimize,
        });
        const lib = b.addLibrary(.{
            .name = source.name,
            .linkage = .dynamic,
            .root_module = root_module,
        });
        const install = b.addInstallArtifact(lib, .{
            .dest_dir = .{ .override = .{ .custom = "native" } },
            .h_dir = .disabled,
        });
        native_step.dependOn(&install.step);
        b.getInstallStep().dependOn(&install.step);

        const test_exe = b.addTest(.{
            .name = b.fmt("{s}-test", .{source.name}),
            .root_module = b.createModule(.{
                .root_source_file = b.path(source.path),
                .target = target,
                .optimize = .Debug,
            }),
        });
        const test_run = b.addRunArtifact(test_exe);
        test_step.dependOn(&test_run.step);
    }

    const bench_exe = b.addExecutable(.{
        .name = "sift-native-bench",
        .root_module = b.createModule(.{
            .root_source_file = b.path("native/bench.zig"),
            .target = target,
            .optimize = bench_optimize,
        }),
    });
    const bench_run = b.addRunArtifact(bench_exe);
    if (b.args) |args| bench_run.addArgs(args);

    const bench_step = b.step("bench", "Run native Zig benchmarks");
    bench_step.dependOn(&bench_run.step);

    const bench_install_step = b.step("bench-install", "Build native Zig benchmark executable");
    bench_install_step.dependOn(&b.addInstallArtifact(bench_exe, .{}).step);
}
