type Props = {
  small?: boolean;
};

export function BrandTile({ small }: Props) {
  return <span className={small ? "brand-tile small" : "brand-tile"}>栞</span>;
}

export function Brand() {
  return (
    <a className="brand" href="#top" aria-label="Shiori">
      <BrandTile />
      <span className="brand-word">Shiori</span>
    </a>
  );
}
