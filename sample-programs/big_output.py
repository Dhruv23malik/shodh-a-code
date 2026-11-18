import sys


def main() -> None:
    # Prints ~2MB of output: should hit the output limit.
    sys.stdout.write("x" * 2_000_000 + "\n")


if __name__ == "__main__":
    main()
