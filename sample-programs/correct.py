import sys


def main() -> None:
    data = sys.stdin.read().strip().split()
    a, b = int(data[0]), int(data[1])
    print(a + b)


if __name__ == "__main__":
    main()
