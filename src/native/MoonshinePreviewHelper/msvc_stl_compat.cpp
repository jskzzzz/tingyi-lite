#include <cstddef>
#include <cstdint>
#include <cstring>
#include <cwctype>

extern "C" {

const void* __stdcall __std_search_1(const void* first1, const void* last1, const void* first2, size_t count2) noexcept {
  const auto* begin = static_cast<const uint8_t*>(first1);
  const auto* end = static_cast<const uint8_t*>(last1);
  const auto* needle = static_cast<const uint8_t*>(first2);
  if (count2 == 0) {
    return begin;
  }
  if (static_cast<size_t>(end - begin) < count2) {
    return end;
  }
  for (const uint8_t* current = begin; current + count2 <= end; current += 1) {
    if (std::memcmp(current, needle, count2) == 0) {
      return current;
    }
  }
  return end;
}

const void* __stdcall __std_find_end_1(const void* first1, const void* last1, const void* first2, size_t count2) noexcept {
  const auto* begin = static_cast<const uint8_t*>(first1);
  const auto* end = static_cast<const uint8_t*>(last1);
  const auto* needle = static_cast<const uint8_t*>(first2);
  if (count2 == 0) {
    return end;
  }
  if (static_cast<size_t>(end - begin) < count2) {
    return end;
  }
  for (const uint8_t* current = end - count2;; current -= 1) {
    if (std::memcmp(current, needle, count2) == 0) {
      return current;
    }
    if (current == begin) {
      break;
    }
  }
  return end;
}

char* __stdcall __std_remove_1(char* first, char* last, char value) noexcept {
  char* output = first;
  for (char* current = first; current != last; current += 1) {
    if (*current != value) {
      *output = *current;
      output += 1;
    }
  }
  return output;
}

size_t __stdcall __std_find_first_not_of_trivial_pos_1(
    const char* first, size_t count, const char* values, size_t valueCount) noexcept {
  for (size_t index = 0; index < count; index += 1) {
    bool found = false;
    for (size_t valueIndex = 0; valueIndex < valueCount; valueIndex += 1) {
      if (first[index] == values[valueIndex]) {
        found = true;
        break;
      }
    }
    if (!found) {
      return index;
    }
  }
  return static_cast<size_t>(-1);
}

size_t __stdcall __std_find_last_not_of_trivial_pos_1(
    const char* first, size_t count, const char* values, size_t valueCount) noexcept {
  for (size_t remaining = count; remaining > 0; remaining -= 1) {
    const char ch = first[remaining - 1];
    bool found = false;
    for (size_t valueIndex = 0; valueIndex < valueCount; valueIndex += 1) {
      if (ch == values[valueIndex]) {
        found = true;
        break;
      }
    }
    if (!found) {
      return remaining - 1;
    }
  }
  return static_cast<size_t>(-1);
}

char32_t* __stdcall __std_unique_4(char32_t* first, char32_t* last) noexcept {
  if (first == last) {
    return last;
  }
  char32_t* output = first;
  for (char32_t* current = first + 1; current != last; current += 1) {
    if (!(*output == *current)) {
      output += 1;
      *output = *current;
    }
  }
  return output + 1;
}

size_t __stdcall __std_regex_transform_primary_char(
    char* first1, char* last1, const char* first2, const char* last2, const void*) noexcept {
  size_t written = 0;
  while (first2 != last2 && first1 != last1) {
    *first1 = *first2;
    first1 += 1;
    first2 += 1;
    written += 1;
  }
  return written;
}

}  // extern "C"
