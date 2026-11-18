import sys


def main() -> None:
    data = sys.stdin.read().strip().split()
    a, b = int(data[0]), int(data[1])
    # Deliberate runtime error (division by zero).
    print((a + b) // 0)


if __name__ == "__main__":
    main()
