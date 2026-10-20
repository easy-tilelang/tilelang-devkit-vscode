"""Run a complete CPU C/Cython JIT, optionally checking the numerical result."""

import argparse

import tilelang
import tilelang.cpu.language as T


def vector_add(size=128):
    if size <= 0:
        raise ValueError("size must be positive")

    @T.prim_func
    def main(A: T.Tensor((size,), "float32"), B: T.Tensor((size,), "float32"), C: T.Tensor((size,), "float32")):
        with T.Kernel(1):
            for i in T.serial(size):
                C[i] = A[i] + B[i]

    return main


def run():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--size", type=int, default=128)
    parser.add_argument("--repeat", type=int, default=2)
    parser.add_argument("--verify", action="store_true")
    args = parser.parse_args()
    if args.repeat <= 0:
        parser.error("--repeat must be positive")
    program = vector_add(args.size)
    for attempt in range(args.repeat):
        kernel = tilelang.compile(program, target="c", execution_backend="cython", out_idx=2)
        print(f"CPU C/Cython JIT compiled and loaded: request {attempt + 1}", flush=True)
        if args.verify:
            import torch

            a = torch.arange(args.size, dtype=torch.float32)
            b = torch.ones(args.size, dtype=torch.float32)
            torch.testing.assert_close(kernel(a, b), a + b)
            print("CPU output verified", flush=True)


if __name__ == "__main__":
    run()
