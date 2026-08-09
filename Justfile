set shell := ["bash", "-eu", "-o", "pipefail", "-c"]

makefile := "kixdns/Makefile"
source_dir := ".cache/kixdns-core/source"
target_root := ".cache/kixdns-core/target"
dist_dir := "dist/core"
cargo_zigbuild_version := "0.23.0"
zig_version := "0.16.0"

# Show the available development commands.
default:
    @just --list

# Install the pinned cargo-zigbuild and Zig toolchain for local development.
setup:
    python3 -m pip install --user --upgrade "cargo-zigbuild=={{cargo_zigbuild_version}}" "ziglang=={{zig_version}}"
    @echo "Ensure the Python user bin directory is in PATH, then run: just doctor"

# Install the same pinned toolchain into the active CI Python environment.
setup-ci:
    python3 -m pip install "cargo-zigbuild=={{cargo_zigbuild_version}}" "ziglang=={{zig_version}}"

# Check the tools required by the local core build.
doctor:
    @for command in git cargo rustup python3; do \
        command -v "$command" >/dev/null || { echo "Missing required command: $command" >&2; exit 1; }; \
    done
    @cargo-zigbuild --version
    @(python-zig version 2>/dev/null || zig version 2>/dev/null || python3 -m ziglang version)
    @echo "cargo-zigbuild toolchain is ready"

# Fetch the exact upstream revision pinned by the OpenWrt package.
core-fetch:
    @upstream="$(sed -n 's/^PKG_SOURCE_URL:=//p' "{{makefile}}")"; \
    revision="$(sed -n 's/^PKG_SOURCE_VERSION:=//p' "{{makefile}}")"; \
    test -n "$upstream" || { echo "PKG_SOURCE_URL is missing from {{makefile}}" >&2; exit 1; }; \
    test -n "$revision" || { echo "PKG_SOURCE_VERSION is missing from {{makefile}}" >&2; exit 1; }; \
    mkdir -p "{{source_dir}}"; \
    if [ ! -d "{{source_dir}}/.git" ]; then \
        git -C "{{source_dir}}" init -q; \
        git -C "{{source_dir}}" remote add origin "$upstream"; \
    else \
        git -C "{{source_dir}}" remote set-url origin "$upstream"; \
    fi; \
    current="$(git -C "{{source_dir}}" rev-parse HEAD 2>/dev/null || true)"; \
    if [ "$current" != "$revision" ]; then \
        echo "Fetching kixdns $revision"; \
        git -C "{{source_dir}}" fetch --depth=1 origin "$revision"; \
        git -C "{{source_dir}}" checkout -q --detach FETCH_HEAD; \
    else \
        echo "kixdns $revision is already available"; \
    fi

# Build the pinned core with Zig. Both OpenWrt ARM64 package arches use one generic binary.
core-build arch="x86_64": doctor core-fetch
    @case "{{arch}}" in \
        x86_64) target="x86_64-unknown-linux-musl" ;; \
        aarch64|aarch64_generic|aarch64_cortex-a53) target="aarch64-unknown-linux-musl" ;; \
        *) echo "Unsupported architecture: {{arch}}" >&2; exit 1 ;; \
    esac; \
    rustup target add "$target"; \
    zig_path="$(command -v python-zig 2>/dev/null || command -v zig 2>/dev/null || true)"; \
    test -n "$zig_path" || { echo "Zig is unavailable; run just setup" >&2; exit 1; }; \
    mkdir -p "{{dist_dir}}" "{{target_root}}/{{arch}}"; \
    echo "Building kixdns for {{arch}} ($target)"; \
    CARGO_TARGET_DIR="$(pwd)/{{target_root}}/{{arch}}" \
    CARGO_ZIGBUILD_CACHE_DIR="$(pwd)/.cache/kixdns-core/zigbuild" \
    CARGO_ZIGBUILD_ZIG_PATH="$zig_path" \
        cargo zigbuild --manifest-path "{{source_dir}}/Cargo.toml" --locked --release --target "$target"; \
    install -m 0755 "{{target_root}}/{{arch}}/$target/release/kixdns" "{{dist_dir}}/kixdns-{{arch}}"; \
    echo "Created {{dist_dir}}/kixdns-{{arch}}"

# Build the two binaries used by all published OpenWrt package architectures.
core-build-all:
    just core-build x86_64
    just core-build aarch64

# Verify the ELF architecture and static linkage of a built core binary.
core-verify arch="x86_64":
    @binary="{{dist_dir}}/kixdns-{{arch}}"; \
    header="$(readelf -h "$binary")"; \
    file "$binary"; \
    printf '%s\n' "$header"; \
    case "{{arch}}" in \
        x86_64) expected_machine='Advanced Micro Devices X86-64' ;; \
        aarch64) expected_machine='AArch64' ;; \
        *) echo "Unsupported architecture: {{arch}}" >&2; exit 1 ;; \
    esac; \
    actual_machine="$(awk -F: '/Machine:/{sub(/^[[:space:]]+/, "", $2); print $2}' <<< "$header")"; \
    test "$actual_machine" = "$expected_machine" || { \
        echo "Unexpected ELF machine for {{arch}}: $actual_machine" >&2; exit 1; \
    }; \
    ! readelf -l "$binary" | grep -q 'INTERP' || { \
        echo "The core binary has a dynamic interpreter" >&2; exit 1; \
    }; \
    ! readelf -d "$binary" 2>/dev/null | grep -q '(NEEDED)' || { \
        echo "The core binary has dynamic library dependencies" >&2; exit 1; \
    }; \
    if [ "{{arch}}" = x86_64 ]; then "$binary" --version; fi

# Put a downloaded core artifact where the OpenWrt package expects it.
core-stage arch:
    @source="kixdns/prebuilt/kixdns-{{arch}}"; \
    target="kixdns/prebuilt/kixdns"; \
    test -f "$source" || { echo "Missing core artifact: $source" >&2; exit 1; }; \
    mv "$source" "$target"; \
    chmod 0755 "$target"

# Collect the core and LuCI packages into one release archive.
package-output arch release package_ext:
    @package_dir="bin/packages/{{arch}}/kixdns"; \
    output="kixdns_{{arch}}-openwrt-{{release}}.tar.gz"; \
    staging_dir="$(mktemp -d)"; \
    trap 'rm -rf "$staging_dir"' EXIT; \
    find_package() { \
        find "$package_dir" -maxdepth 1 -type f \
            \( -name "$1-*.{{package_ext}}" -o -name "$1_*.{{package_ext}}" \) \
            -print -quit; \
    }; \
    core_package="$(find_package kixdns)"; \
    luci_package="$(find_package luci-app-kixdns)"; \
    if [ -z "$core_package" ] || [ -z "$luci_package" ]; then \
        echo "Expected kixdns and luci-app-kixdns .{{package_ext}} packages in $package_dir" >&2; \
        find "$package_dir" -maxdepth 1 -type f -print >&2 || true; \
        exit 1; \
    fi; \
    cp "$core_package" "$luci_package" "$staging_dir/"; \
    tar -czf "$output" -C "$staging_dir" .; \
    echo "Created $output"

# Remove local core source, compiler caches, and generated binaries.
clean:
    rm -rf .cache/kixdns-core "{{dist_dir}}"
