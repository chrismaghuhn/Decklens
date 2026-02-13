import * as React from "react"
import { Search } from "lucide-react"

import { cn } from "@/lib/utils"
import { Input } from "@/components/ui/input"

export interface SearchBarProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'onChange'> {
  onSearch: (query: string) => void;
  debounceTime?: number;
}

const SearchBar = React.forwardRef<HTMLInputElement, SearchBarProps>(
  ({ className, onSearch, debounceTime = 500, ...props }, ref) => {
    const [value, setValue] = React.useState("");
    const timeoutRef = React.useRef<NodeJS.Timeout | null>(null);

    const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
      const newValue = e.target.value;
      setValue(newValue);

      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }

      timeoutRef.current = setTimeout(() => {
        onSearch(newValue);
      }, debounceTime);
    };

    return (
      <div className={cn("relative flex h-10 w-full items-center", className)}>
        <Search className="absolute left-3 h-4 w-4 text-muted-foreground" />
        <Input
          ref={ref}
          type="search"
          placeholder="Search for cards..."
          className="pl-9 pr-4"
          value={value}
          onChange={handleChange}
          {...props}
        />
      </div>
    );
  }
);
SearchBar.displayName = "SearchBar";

export { SearchBar };
