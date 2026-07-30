# Benchmarks

```sh
npm run bench
```

## Methodology

Each mode runs 100 warm-up appends followed by 10,000 measured appends of `{ value: 42 }`. The benchmark measures the `append` call only — the path from "value handed to the library" to "sequence number returned" — because that is the latency your request handler actually pays before it can acknowledge work.

These numbers compare **durability modes and filesystems on one machine**, not machines against each other. Both tables below come from the same laptop and the same physical NVMe device, so the difference between them is the operating system and filesystem alone. Rerun the benchmark on your deployment filesystem before making a capacity decision.

## Results

Intel Core i7-10875H, WD SN730 1 TB NVMe SSD. Measured 2026-07-31.

### Windows 11 — NTFS, Node 24.18.0

| Mode           |      Mean |       p75 |       p99 |    Throughput |
| -------------- | --------: | --------: | --------: | ------------: |
| `fsync: false` | 0.0067 ms | 0.0065 ms | 0.0216 ms | 148,684 ops/s |
| `fsync: true`  | 0.4689 ms | 0.4782 ms | 0.7449 ms |   2,133 ops/s |

### Linux — WSL2 Ubuntu 24.04, ext4, Node 24.14.1

| Mode           |      Mean |       p75 |       p99 |    Throughput |
| -------------- | --------: | --------: | --------: | ------------: |
| `fsync: false` | 0.0027 ms | 0.0023 ms | 0.0129 ms | 371,113 ops/s |
| `fsync: true`  | 1.4912 ms | 1.5429 ms | 2.1581 ms |     671 ops/s |

Run inside the WSL2 root filesystem, not a `/mnt/c` mount, which would measure the Windows interop bridge instead of ext4. WSL2's ext4 lives on a virtual disk backed by the NVMe above, so its `fsync` figure carries virtualization overhead that bare-metal Linux would not. Treat it as a lower bound on native Linux, not a substitute for measuring one.

## Reading these numbers

The gap between modes — 70× on NTFS, 553× on ext4 — is the entire cost of host-loss durability, and it is why `fsync` is opt-in rather than the default.

The two tables make the more important point. The same code on the same physical device gives a `fsync: true` cost of 0.47 ms or 1.49 ms depending only on the OS and filesystem underneath, and the ordering even reverses: ext4 is 2.5× faster than NTFS without `fsync` and 3× slower with it. Any single number quoted here is a property of the filesystem it was measured on, not of this library.

At the slower of the two, 671 appends per second, `fsync: true` is still comfortably above the write rate of most webhook receivers, IoT agents, and desktop applications — the workloads this library targets. It is not appropriate for high-rate ingestion without batching.

Cloud block storage (EBS, Persistent Disk, managed NVMe) typically shows a substantially worse `fsync` figure than a local consumer SSD. Container overlay layers add more. Measure where you deploy.
