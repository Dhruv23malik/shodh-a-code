import sys


def main() -> None:
    data = sys.stdin.read().strip().split()
    a, b = int(data[0]), int(data[1])
    # Off-by-one: wrong answer on every case.
    print(a + b + 1)


if __name__ == "__main__":
    main()
